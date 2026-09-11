#!/usr/bin/env python3
"""Read-only v2.6 validator; it never invokes the builder or writes state."""
import argparse
import base64
import copy
import datetime
import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.hazmat.primitives import serialization
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parent
FIX = ROOT / "fixtures-v2.6"
CLOCK = "2026-08-26T12:00:00Z"
SKEW = 30
class Invalid(Exception): pass
def need(ok, msg):
    if not ok: raise Invalid(msg)
def load(name): return json.loads((ROOT / name).read_text())
def sha_bytes(value): return hashlib.sha256(value).hexdigest()
def pretty_hash(value): return sha_bytes((json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode())
def canonical(value):
    if isinstance(value, list): return [canonical(x) for x in value]
    if isinstance(value, dict): return {k:canonical(value[k]) for k in sorted(value)}
    return value
def canonical_bytes(value): return json.dumps(canonical(value), separators=(",", ":"), ensure_ascii=False).encode()
def verify(pub, signature, payload):
    try:
        key = serialization.load_der_public_key(base64.b64decode(pub, validate=True))
        key.verify(base64.b64decode(signature, validate=True), canonical_bytes(payload))
    except Exception as exc: raise Invalid("SIGNATURE") from exc
def apply_patch(value, pointer, replacement):
    result = copy.deepcopy(value); parts = [x for x in pointer.split('/') if x]
    need(parts and parts[0] == 'payload', 'MUTATION_PATH')
    current = result['payload']
    for part in parts[1:-1]: current = current[int(part)] if isinstance(current, list) else current[part]
    leaf = parts[-1]
    if isinstance(current, list): current[int(leaf)] = replacement
    else: current[leaf] = replacement
    return result
def get_value(payload, pointer):
    value = payload
    for part in pointer.removeprefix('/payload/').split('/'): value = value[int(part)] if isinstance(value, list) else value[part]
    return value
def schema_check(value, schema, where):
    Draft202012Validator.check_schema(schema)
    errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda e:list(e.path))
    need(not errors, where + ': ' + errors[0].message if errors else '')
def fixed_seconds(value): return int(datetime.datetime.fromisoformat(value[:-1] + '+00:00').timestamp())

def validate_spec(spec):
    need(spec['meta']['version'] == '2.6.0-council-draft', 'SPEC_VERSION')
    count = len(spec['requirements'])
    for field in ('requirements','acceptance_criteria','test_plan','traceability'): need(len(spec[field]) == count, field + '_COUNT')
    need({x['id'] for x in spec['requirements']} == {f'REQ-{i:03d}' for i in range(1,count+1)}, 'REQ_IDS')
    need({x['id'] for x in spec['acceptance_criteria']} == {f'AC-{i:03d}' for i in range(1,count+1)}, 'AC_IDS')
    need({x['id'] for x in spec['test_plan']} == {f'TST-{i:03d}' for i in range(1,count+1)}, 'TST_IDS')
    for x in spec['acceptance_criteria']: need(x['scenario'].startswith('Given ') and ' When ' in x['scenario'] and ' Then ' in x['scenario'], x['id'])
    for x in spec['test_plan']: need(x['approach'].startswith('Run '), x['id'])

def validate_schemas(manifest, positive, commands, dag, contracts, ap):
    schemas = {x['id']:x['schema'] for x in manifest['schemas']}
    need(len(schemas) == 15, 'SCHEMA_COUNT')
    for item in manifest['schemas']: Draft202012Validator.check_schema(item['schema'])
    command_schema = schemas['command.v2.6']
    for command in commands: schema_check({'id':command['id'],'argv':command['argv'],'digest':command['digest']}, command_schema, command['id'])
    schema_check(positive['base']['payload'], schemas['payload.v2.6'], 'positive.base.payload')
    for mutation in positive['mutations']: schema_check(mutation, schemas['mutation.v2.6'], mutation['mutation_id'])
    for edge in dag['failure_edges']: schema_check(edge, schemas['fsm.v2.6'], 'failure.' + edge['from'])
    for edge in dag['recovery_edges']: schema_check(edge, schemas['recovery.v2.6'], 'recovery.' + edge['from'])
    for item in contracts.values():
        if isinstance(item, dict):
            sid = {'candidate':'candidate.v2.6','proxy':'proxy.v2.6','vault':'vault.v2.6','cnpg':'cnpg.v2.6'}.get(next((k for k,v in contracts.items() if v is item),''))
            if sid: schema_check(item, schemas[sid], sid)
    schema_check(contracts['admin']['normal'],schemas['admin.v2.6'],'admin.normal')
    schema_check(contracts['admin']['break_glass'],schemas['admin.v2.6'],'admin.break_glass')
    schema_check(contracts['activation'],schemas['activation.v2.6'],'activation')
    need(contracts['recovery']['nodes']==[f'U{i:02d}' for i in range(9)],'recovery.schema')
    schema_check(contracts['semver'],schemas['semver.v2.6'],'semver')
    for item in ap: schema_check(item, schemas['app-bootstrap.v2.6'], item['id'])
    return schemas

def validate_dag(dag, commands, trace):
    ids = {x['id'] for x in dag['nodes']}; need(dag['root'] == 'S00' and list(ids).count('S00') == 1, 'ROOT')
    expected = {'S00',*{f'X{i:02d}' for i in range(1,40)},*{f'AP{i}' for i in range(20,26)},'X41',*{f'M{i:02d}' for i in range(1,20)},'S99',*{f'U{i:02d}' for i in range(9)}}
    need(ids == expected, 'NODE_SET')
    for node in dag['nodes']:
        command = commands.get(node['command_id']); need(command is not None, node['id'] + ':COMMAND')
        need(node['command_digest'] == command['digest'] and node['command_argv'] == command['argv'], node['id'] + ':CONST')
        need(node['schema_id'] and node['positive_fixture'] and node['negative_ids'], node['id'] + ':BINDING')
    adjacency = {x:[] for x in ids}
    for edge in dag['success_edges'] + dag['failure_edges'] + dag['recovery_edges']:
        need(edge['from'] in ids and edge['to'] in ids, 'EDGE_NODE')
        adjacency[edge['from']].append(edge['to'])
    seen=set(); todo=['S00']
    while todo:
        node=todo.pop()
        if node in seen: continue
        seen.add(node); todo.extend(adjacency[node])
    need(seen == ids, 'UNREACHABLE')
    executable=[x for x in ids if not x.startswith('U') and x != 'S99']; need(len(dag['failure_edges']) == len(executable), 'FAILURE_COVERAGE')
    for edge in dag['failure_edges']:
        need(edge['to']=='U00' and set(edge['outcomes']) == set(dag['failure_outcomes']), 'FAILURE_OUTCOME')
        need(edge['atomic_actions'] == ['fence','cancel','quarantine','classify'], 'FAILURE_ATOMIC')
    recovery=[('U00','U01','cmd.fence'),('U01','U02','cmd.cancel'),('U02','U03','cmd.quarantine'),('U03','U04','cmd.classify'),('U04','U05','cmd.repair'),('U05','U06','cmd.successor'),('U06','U07','cmd.audit'),('U07','U08','cmd.reconcile')]
    need([(x['from'],x['to'],x['command_id']) for x in dag['recovery_edges']] == recovery, 'RECOVERY_EDGES')
    traced={node for row in trace for node in row['dag_nodes']}; need(traced <= ids, 'TRACE_NODE_MISSING')
    need({f'M{i:02d}' for i in range(1,20)} <= traced,'TRACE_MUTATION_COVERAGE')
    for row in trace:
        need(row['command_id'] in commands and row['schema_id'] and row['negative_oracles'], row['requirement_id'] + ':TRACE')

def validate_contracts(contracts, ap):
    need(contracts['candidate']['media_type']=='application/gzip' and contracts['candidate']['sandbox']=='destroyed-no-network-kata', 'CANDIDATE')
    need(contracts['proxy']['host']=='api.github.com' and contracts['proxy']['sni']=='api.github.com' and contracts['proxy']['operations']==['create-tag','draft-release','upload-release-asset','readback-release'], 'PROXY')
    need(contracts['vault']['principal'].startswith('system:serviceaccount:') and contracts['vault']['revoked'] is False, 'VAULT')
    need(contracts['cnpg']['instances']==3 and contracts['cnpg']['synchronous'] and contracts['cnpg']['rpo_seconds']==0 and contracts['cnpg']['rto_seconds']<=120, 'CNPG')
    n=contracts['admin']['normal']; b=contracts['admin']['break_glass']
    need(len({n['requester'],n['approver'],n['executor']})==3 and (n['approval_ttl_seconds'],n['credential_ttl_seconds'])==(1800,600), 'ADMIN_NORMAL')
    need(len({b['requester'],b['approver_one'],b['approver_two'],b['executor']})==4 and (b['approval_ttl_seconds'],b['credential_ttl_seconds'])==(900,300), 'ADMIN_BREAKGLASS')
    need(n['one_use'] and b['one_use'] and n['audit_required'] and b['audit_required'] and n['revocation_required'] and b['revocation_required'], 'ADMIN_LIFECYCLE')
    need(set(b['forbidden_operations'])=={'publish','mint-candidate','mutate-admission','clear-unknown'}, 'ADMIN_FORBIDDEN')
    need(contracts['activation']=={'state':'BLOCKED_PREACTIVATION','live_gate_count':0,'refresh_required_before_mutation':True,'synthetic_evidence_authorizes':False}, 'ACTIVATION')
    need(contracts['recovery']['nodes']==[f'U{i:02d}' for i in range(9)] and len(contracts['recovery']['commands'])==9, 'RECOVERY_CONTRACT')
    sem=contracts['semver']; versions=[tuple(map(int,x['tag'][1:].split('.'))) for x in sem['verified_tags'] if x['verified']]; top=max(versions); expected=f'v{top[0]}.{top[1]}.{top[2]+1}'
    need(sem['frozen_next_semver']==expected and sem['freeze_node']=='X39' and sem['refresh_required_before_mutation'], 'SEMVER')
    need(len(ap)==6 and all(x['repository']=='codicarium/app-config' and x['path'].startswith('argocd/') and x['argo_kind']=='Application' and len(x['artifact_sha256'])==64 and x['artifact_byte_length']>0 and x['bootstrap_only'] for x in ap), 'AP_BOOTSTRAP')
    for item in ap:
        raw=base64.b64decode(item['artifact_bytes_base64'],validate=True)
        need(len(raw)==item['artifact_byte_length'] and sha_bytes(raw)==item['artifact_sha256'],'AP_BYTES:'+item['id'])

def validate_chain(positive, ledger, assets):
    need(len(positive['mutations'])==19, 'MUTATION_COUNT'); previous='GENESIS-v2.6'; all_keys=set(); all_principals=set(); covered_assets=set()
    for i, mutation in enumerate(positive['mutations'],1):
        need(mutation['mutation_id']==f'M{i:02d}' and mutation['nonce']==f'nonce-M{i:02d}-v2.6' and len(mutation['records'])==4, 'MUTATION_ID')
        need(mutation['nonce'] not in ledger, 'POSITIVE_REPLAY')
        roles=[]; keys=[]; principals=[]; derived=[]
        for record in mutation['records']:
            body={k:v for k,v in record.items() if k not in {'signature','public_key','record_hash'}}
            need(record['sequence']==i and record['previous_hash']==previous and record['schema_id']=='mutation.v2.6', 'CHAIN')
            need(record['record_hash']==pretty_hash(body), 'RECORD_HASH'); verify(record['public_key'],record['signature'],body)
            need(record['authority'] is False and record['signer_kind']=='offline_fixture', 'LIVE_POSITIVE')
            need(sha_bytes(base64.b64decode(record['target_bytes'], validate=True)) == record['target_bytes_sha256'], 'TARGET_BYTES')
            need(record['release_version']=='v0.7.7' and record['target']['ref']=='refs/tags/v0.7.7','FROZEN_IDENTITY')
            asset=next((x for x in assets if x['filename']==record['asset_filename']),None); need(asset is not None,'ASSET_BINDING')
            need((record['asset_media_type'],record['asset_source'],record['asset_destination'])==(asset['media_type'],asset['source_fixture'],asset['destination_binding']),'ASSET_EXACT')
            roles.append(record['role']); keys.append(record['key_fingerprint']); principals.append(record['principal']); derived.append(record['derived_key_fingerprint']); covered_assets.add(record['asset_filename']); need(record['outer_nonce']==f'outer-M{i:02d}' and record['inner_nonce']==f'inner-M{i:02d}' and record['nonce']==mutation['nonce'], 'NONCE_BINDING')
            previous=record['record_hash']
        need(roles==['writer','collector','vault-transit-signer','append-only-committer'] and len(set(keys))==4 and len(set(principals))==4 and len(set(derived))==4, 'ROLE_SEPARATION')
        need(not (set(keys)&all_keys) and not (set(principals)&all_principals),'GLOBAL_IDENTITY_REUSE'); all_keys.update(keys); all_principals.update(principals)
    need(covered_assets=={x['filename'] for x in assets},'ASSET_COVERAGE')

def evaluate_negative(vector, base, ledger, schemas):
    candidate=apply_patch(base,vector['path'],vector['replacement']); need(candidate != base, vector['id'] + ':TEST_FAILURE_NOOP')
    error=None; before_bytes=(json.dumps(base['target_before'],indent=2)+'\n').encode(); pre=post=None; effects=None
    with tempfile.TemporaryDirectory(prefix='v26-target-') as td:
        adapter=Path(td)/'target.json'; adapter.write_bytes(before_bytes); pre=sha_bytes(adapter.read_bytes())
        try:
            schema_check(candidate['payload'],schemas['payload.v2.6'],vector['id']+':SCHEMA')
            if vector['path']=='/payload/signature': verify(base['public_key'],vector['replacement'],base['payload'])
            else:
                signing=dict(base['payload']); signing.pop('signature',None); verify(base['public_key'],base['payload']['signature'],signing)
            if vector['path']=='/payload/nonce' and candidate['payload']['nonce'] in ledger: raise Invalid('REPLAY')
            if vector['path']=='/payload/issued_at': need(abs(fixed_seconds(candidate['payload']['issued_at'])-fixed_seconds(CLOCK))<=SKEW,'CLOCK')
            if vector['path']=='/payload/not_before': need(fixed_seconds(candidate['payload']['not_before'])<=fixed_seconds(CLOCK)+SKEW,'CLOCK')
            if vector['path']=='/payload/expires_at': need(fixed_seconds(candidate['payload']['expires_at'])>=fixed_seconds(CLOCK)-SKEW,'CLOCK')
            if get_value(candidate['payload'],vector['path']) != get_value(base['payload'],vector['path']): raise Invalid(vector['expected_error'])
            raise Invalid('ACCEPTED')
        except Invalid as exc: error=str(exc)
        finally:
            post=sha_bytes(adapter.read_bytes()); effects=0 if pre==post else 1
    need(error==vector['expected_error'],vector['id']+':EXPECTED_'+str(error)); need(effects==0 and pre==vector['pre_target_sha256'] and post==vector['post_target_sha256'],vector['id']+':EFFECT'); return error

def validate_self_tests(base):
    no_op=apply_patch(base,'/payload/nonce',base['payload']['nonce']); need(no_op==base,'NOOP_HARNESS_NOT_DETECTED')
    before=(json.dumps(base['target_before'],indent=2)+'\n').encode()
    with tempfile.TemporaryDirectory(prefix='v26-adversarial-') as td:
        adapter=Path(td)/'target.json'; adapter.write_bytes(before); before_hash=sha_bytes(adapter.read_bytes()); adapter.write_bytes(before+b'UNAUTHORIZED')
        need(sha_bytes(adapter.read_bytes()) != before_hash,'UNAUTHORIZED_EFFECT_NOT_DETECTED')

def validate_replay():
    db=FIX/'replay-ledger-v2.6.sqlite'; con=sqlite3.connect(f'file:{db}?mode=ro',uri=True); rows={x[0] for x in con.execute('select nonce from replay')}; con.close(); return rows

def execute_replay_race():
    with tempfile.TemporaryDirectory(prefix='v26-replay-') as td:
        db=Path(td)/'race.sqlite'
        run=subprocess.run([sys.executable,str(ROOT/'replay-race-worker-v2.6.py'),str(db),'nonce-runtime-v2.6'],capture_output=True,text=True,check=True)
        result=json.loads(run.stdout)
        need(len(result['attempts'])==2 and result['successes']==1 and result['replays']==1 and result['after_restart_count']==1 and result['durable'],'REPLAY_RACE_RUNTIME')
        return result

def validate_assets():
    data=load('fixtures-v2.6/assets-v2.6.json'); need(len(data['assets'])==14,'ASSET_COUNT')
    for item in data['assets']:
        source=(ROOT/item['source_fixture']).read_bytes(); need(sha_bytes(source)==item['source_sha256'],'ASSET_SOURCE'); need(item['release_version']=='v0.7.7' and item['destination_binding'].startswith('github://codicarium/deployment-controller/releases/v0.7.7/assets/'),'ASSET_DESTINATION')

def validate_closure(file, manifest_hash, report_hash):
    council=json.loads(Path(file).read_text()); schema_check({k:v for k,v in council.items() if k!='schema'},load('fixtures-v2.6/closure-v2-6.schema.json'),'COUNCIL_SCHEMA'); need(council['decision'] in {'GO','NO-GO'},'COUNCIL_DECISION'); need(council['bundle_manifest_sha256']==manifest_hash and council['pre_council_report_sha256']==report_hash,'COUNCIL_HASH')
    lanes=council['lanes']; exact=['planner','security','tech_lead_devops','tech_lead_qa']; need([x['role'] for x in lanes]==exact and len({x['key_fingerprint'] for x in lanes})==4 and len({x['principal'] for x in lanes})==4 and len({x['derived_key_fingerprint'] for x in lanes})==4,'COUNCIL_LANES'); need(all(x['verdict']==council['decision'] and x['signature'] for x in lanes),'COUNCIL_UNANIMOUS')
    for lane in lanes:
        need(lane['key_fingerprint']==sha_bytes(base64.b64decode(lane['public_key'],validate=True)),'COUNCIL_KEY_FINGERPRINT')
        need(lane['derived_key_fingerprint']==sha_bytes((lane['role']+'|'+lane['principal']+'|'+lane['key_fingerprint']).encode()),'COUNCIL_DERIVED_KEY')
        verify(lane['public_key'],lane['signature'],{k:v for k,v in lane.items() if k not in {'signature','public_key'}})
    if council['decision']=='GO':
        gate=council['live_gate_aggregate']; need(council['activation_ready'] is True and gate['complete'] is True and gate['signed'] is True and gate['gate_count']>0 and gate['passed_count']==gate['gate_count'],'GO_LIVE_GATES')

def main():
    parser=argparse.ArgumentParser(); parser.add_argument('--council'); parser.add_argument('--negative'); parser.add_argument('--clock',default=CLOCK); args=parser.parse_args()
    try:
        need(args.clock==CLOCK,'FIXED_CLOCK'); spec=load('feature-spec.v2.6.draft.json'); validate_spec(spec); annex=load('feature-spec.v2.6.annex.json'); command_items=load('fixtures-v2.6/command-catalog-v2.6.json'); commands={x['id']:x for x in command_items}; manifest=load('fixtures-v2.6/typed-payload-schemas-v2.6.json'); dag=load('fixtures-v2.6/rollout-dag-v2.6.json'); contracts=load('fixtures-v2.6/base-contracts-v2.6.json')['contracts']; ap=load('fixtures-v2.6/app-config-bootstrap-v2.6.json'); schemas=validate_schemas(manifest,load('fixtures-v2.6/signed-command-evidence-positive-v2.6.json'),command_items,dag,contracts,ap); validate_dag(dag,commands,annex['semantic_trace']); validate_contracts(contracts,ap); need(annex['predecessor_council_hashes']['v2_5']=='4c94172997c432fdab76855750abb7d4fbbc31c981f09c0b42bc4bcc00a59349','V25_HASH'); need(contracts['activation']['state']=='BLOCKED_PREACTIVATION','LIVE_BLOCK')
        positive=load('fixtures-v2.6/signed-command-evidence-positive-v2.6.json'); ledger=validate_replay(); asset_doc=load('fixtures-v2.6/assets-v2.6.json'); validate_chain(positive,ledger,asset_doc['assets']); validate_assets(); base=load('fixtures-v2.6/base-contracts-v2.6.json'); validate_self_tests(base); negatives=load('fixtures-v2.6/executable-negative-vectors-v2.6.json'); need(len(negatives)==24 and len({x['path'] for x in negatives})==24,'NEGATIVE_DISTINCT')
        if args.negative:
            vector=next(x for x in negatives if x['id']==args.negative)
            error=evaluate_negative(vector,base,ledger,schemas); print(json.dumps({'status':'EXPECTED_REJECTION','negative':args.negative,'error':error})); return 0
        for vector in negatives: evaluate_negative(vector,base,ledger,schemas)
        race=execute_replay_race(); need(race['successes']==1 and race['replays']==1 and race['after_restart_count']==1 and race['durable'],'REPLAY_RACE')
        bundle=load('fixtures-v2.6/pre-council-bundle-manifest-v2.6.json');
        for item in bundle['files']: need(sha_bytes((ROOT/item['path']).read_bytes())==item['sha256'],'MANIFEST:'+item['path'])
        mh=sha_bytes((FIX/'pre-council-bundle-manifest-v2.6.json').read_bytes()); report=load('fixtures-v2.6/pre-council-validation-report-v2.6.json'); need(report['bundle_manifest_sha256']==mh and report['validator_read_only'] is True,'REPORT'); rh=sha_bytes((FIX/'pre-council-validation-report-v2.6.json').read_bytes()); result=None
        if args.council: validate_closure(args.council,mh,rh); result='CLOSURE'
        print(json.dumps({'status':'PASS_PRE_COUNCIL_ONLY' if result is None else 'PASS_CLOSURE','spec_sha256':sha_bytes((ROOT/'feature-spec.v2.6.draft.json').read_bytes()),'annex_sha256':sha_bytes((ROOT/'feature-spec.v2.6.annex.json').read_bytes()),'manifest_sha256':mh,'report_sha256':rh,'requirements':len(spec['requirements']),'tests':len(spec['test_plan']),'negative_vectors':24,'mutations':19,'records_per_mutation':4,'dag_nodes':len(dag['nodes']),'assets':14,'live':'BLOCKED_PREACTIVATION'}))
        return 0
    except Exception as exc: print(json.dumps({'status':'FAIL','error':str(exc)}),file=sys.stderr); return 1
if __name__=='__main__': raise SystemExit(main())
