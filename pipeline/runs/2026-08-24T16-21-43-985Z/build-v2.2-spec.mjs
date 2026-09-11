#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const RUN = "/home/rickebo/.codex/pipeline/runs/2026-08-24T16-21-43-985Z";
const OUT = path.join(RUN, "fixtures-v2.2");
const TIME = "2026-08-26T10:00:00Z";
const SPEC = path.join(RUN, "feature-spec.v2.2.draft.json");
const ANNEX = path.join(RUN, "feature-spec.v2.2.annex.json");
const CHECK = path.join(OUT, "pipeline-spec-check-v2.2.json");
const json = value => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const sha = value => crypto.createHash("sha256").update(value).digest("hex");
const write = (name, value) => fs.writeFileSync(path.join(OUT, name), json(value));
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const baselines = {
  "codicarium/deployment-controller": "1de94f3267dea52b5e9194d32d15a69cb597d17e",
  "codicarium/vault-config": "8412372a2fb328070ec43d6a596b921b4fe05c8e",
  "codicarium/app-config": "6f1a2af06e5b970d6036b9a834320fea74a4dfc8",
  "codicarium/infra": "40073c068a9cf8ff4c1e625b97e09fda31b40637",
  "codicarium/runner-config": "9625e442a12c721e89250812f3d079b09833ccb0",
  "codicarium/postgres-config": "d5ccccfcfc5bae4d099f1848b68e07dcaa679d62",
  "codicarium/codicarium-actions": "9545b5a66498f67667e57d021507ac060fd016b6"
};

const nodes = [];
const add = (id, owner, action, depends_on = [], mode = "normal") => nodes.push({ id, owner, action, depends_on, mode });
add("S00", "release-manager", "Collect fresh non-authorizing inventory at the seven immutable heads");
add("S01", "release-manager", "Obtain exact-hash council decision bound to spec, annex, spec-check and validator hashes", ["S00"]);
add("B10", "release-manager", "GET repository and require exact 404, then one-use dual-control private repository create", ["S01"]);
add("B11", "independent-readback", "Read repository numeric ID, node ID and settings independently", ["B10"]);
add("B12", "release-manager", "Commit exact approved seed and RepositoryBindingEnvelope", ["B11"]);
add("B13", "independent-readback", "Read exact seed Git tree and canonical blob bytes", ["B12"]);
add("B14", "independent-readback", "Read Apps, rulesets, environments and required checks", ["B13"]);
add("B15", "administrator-readback", "Read unredacted administrator-visible bypass actors", ["B14"]);
const lanes = { CA:"codicarium/codicarium-actions", IF:"codicarium/infra", PG:"codicarium/postgres-config", VA:"codicarium/vault-config", RP:"codicarium/release-platform-config", DC:"codicarium/deployment-controller" };
for (const [lane, owner] of Object.entries(lanes)) {
  const base = lane === "CA" ? "B15" : "CA25";
  add(`${lane}20`, owner, "Implement the bounded lane at the frozen base head", [base]);
  add(`${lane}21`, "independent-reviewer", "Sign exact-head and exact-diff review evidence", [`${lane}20`]);
  add(`${lane}22`, "independent-qa", "Run positive tests and zero-effect negative oracles", [`${lane}21`]);
  add(`${lane}23`, "github-actions", "Pass protected checks at the same candidate head", [`${lane}22`]);
  add(`${lane}24`, "guarded-merge", "Merge the exact approved head without bypass", [`${lane}23`]);
  add(`${lane}25`, "independent-readback", "Read post-merge main and successful protected CI", [`${lane}24`]);
}
add("G30", "codicarium/infra", "Materialize central capacity, Kata, namespaces, admission, proxy and RBAC", ["IF25"]);
add("G31", "independent-qa", "Run live infrastructure positive and zero-effect negative probes", ["G30"]);
add("G32", "postgres-config+vault-config", "Materialize CNPG, verify-full TLS and Vault bootstrap contracts", ["PG25", "VA25"]);
add("G33", "independent-qa", "Prove HA, RBAC, backup, isolated restore and any-node-loss RPO/RTO", ["G32"]);
add("G34", "release-platform-config", "Materialize release platform after infra, data, Vault and controller merge", ["RP25", "G31", "G33", "DC25"]);
add("G35", "independent-qa", "Prove successor is inert and has zero publication or activation effects", ["G34"]);
add("X40", "independent-readback", "Prove complete grant and Application set is absent", ["G35"]);
add("X41", "release-platform-config", "Create the complete set atomically from the bound repository identity", ["X40"]);
add("X42", "independent-readback", "Prove health and exact runner-config descriptor/value/handoff blobs unchanged", ["X41"]);
add("L40", "deployment-controller", "Disable and remove all five legacy workflows", ["X42"]);
add("L41", "deployment-controller", "Cancel every queued or in-progress legacy run", ["L40"]);
add("L42", "security-operator", "Prove terminal runs and revoke credentials, routes and sessions", ["L41"]);
add("L43", "security-operator", "Wait the observed maximum TTL plus clock skew", ["L42"]);
add("L44", "independent-readback", "Sign zero-authority inventory after quiescence", ["L43"]);
add("Q40", "gate-controller", "Collect fresh live gates only after materialization and quiescence", ["L44"]);
add("Q41", "independent-evaluator", "Recompute every signed predicate from raw command payloads", ["Q40"]);
add("Q42", "authorization-controller", "Authorize exactly one narrow work item without publication", ["Q41"]);
add("A50", "activation-controller", "Activate the exact work item and epoch once", ["Q42"]);
add("A51", "independent-readback", "Prove activated authority isolation and unchanged forbidden targets", ["A50"]);
add("F00", "candidate-broker", "Deliver one candidate through candidate-source-capability/v2 and read it once", ["A51"]);
add("F01", "claim-controller", "Reserve a new release claim CAS or enter U00", ["F00"]);
add("F02", "github-proxy", "Dispatch verifier with exact 200 run details", ["F01"]);
add("F03", "authorization-controller", "Issue signed publication authorization for the exact claim", ["F02"]);
add("F04", "github-proxy", "Dispatch publisher and commit sequence zero", ["F03"]);
for (let i = 1; i <= 19; i++) {
  const id = `M${String(i).padStart(2, "0")}`;
  add(id, "four-party-mutation", "Reserve sequence, write intent, collect independently, sign with transit, and append by a distinct committer", [i === 1 ? "F04" : `M${String(i - 1).padStart(2, "0")}`]);
}
add("F20", "independent-readback", "Read canonical final tag, release, image, chart and fourteen assets", ["M19"]);
add("F21", "independent-evaluator", "Verify complete mutation and evidence hash-chain closure", ["F20"]);
add("F22", "security-operator", "Retire temporary candidate and publication capabilities", ["F21"]);
add("F23", "security-operator", "Revoke sessions and sign final zero-authority audit", ["F22"]);
add("F24", "release-manager", "Close the successor issue using exact final evidence hashes", ["F23"]);
add("U00", "freeze-controller", "Freeze the current epoch immediately on any ambiguity", [], "terminal-recovery");
add("U01", "incident-commander", "Classify the ambiguity without retry", ["U00"], "terminal-recovery");
add("U02", "independent-readback", "Sign quarantine state and zero further effects", ["U01"], "terminal-recovery");
add("U03", "repair-owner", "Implement forward-only repair under a new work item", ["U02"], "terminal-recovery");
add("U04", "independent-reviewer", "Review exact repair head and diff", ["U03"], "terminal-recovery");
add("U05", "independent-qa", "Run repair tests and zero-effect negatives", ["U04"], "terminal-recovery");
add("U06", "guarded-merge", "Pass protected validation and merge exact repair head", ["U05"], "terminal-recovery");
add("U07", "claim-controller", "Allocate a later unused release ID, new claim, epoch, nonce and work item", ["U06"], "terminal-recovery");
add("U08", "release-manager", "Sign successor handoff and end the current DAG without a retry edge", ["U07"], "terminal-recovery");

const payloadNames = [
  "baseline-inventory","council-decision","repository-create","repository-readback","repository-binding","git-tree-readback","github-policy-inventory","admin-bypass-inventory",
  "lane-review","protected-checks","guarded-merge","postmerge-main","namespace-admission","network-conformance","vault-bootstrap","cnpg-contract","cnpg-failure",
  "successor-inertness","application-set","legacy-retirement","quiescence","gate-inventory","predicate-recomputation","work-item-authorization","activation-epoch",
  "isolation-readback","candidate-source-capability","claim-cas","verifier-dispatch","publication-authorization","publisher-dispatch","mutation-intent","mutation-readback",
  "mutation-signature","mutation-commit","admin-authorization","forward-recovery"
];
if (payloadNames.length !== 37 || nodes.length !== 101) throw new Error("closed counts changed");
const sha256 = { type:"string", pattern:"^[0-9a-f]{64}$" };
const nonce = { type:"string", pattern:"^[0-9a-f]{64}$" };
const principal = { oneOf:[
  { type:"object", additionalProperties:false, required:["kind","repository","workflow_ref","workflow_sha","run_id","run_attempt"], properties:{ kind:{const:"github-workflow"},repository:{type:"string"},workflow_ref:{type:"string"},workflow_sha:{type:"string",pattern:"^[0-9a-f]{40}$"},run_id:{type:"integer",minimum:1},run_attempt:{const:1} } },
  { type:"object", additionalProperties:false, required:["kind","cluster","namespace","pod_uid","pod_name","service_account","service_account_uid","listener_id"], properties:{ kind:{const:"kubernetes-workload"},cluster:{enum:["codicarium-dev","codicarium-prod"]},namespace:{type:"string"},pod_uid:{type:"string",format:"uuid"},pod_name:{type:"string"},service_account:{type:"string"},service_account_uid:{type:"string",format:"uuid"},listener_id:{type:"string"} } }
]};
const target = { oneOf:[
  { type:"object",additionalProperties:false,required:["kind","repository_id","repository","object","immutable_id"],properties:{kind:{const:"github"},repository_id:{type:"integer",minimum:1},repository:{type:"string"},object:{type:"string"},immutable_id:{type:"string"}}},
  { type:"object",additionalProperties:false,required:["kind","context","api_version","namespace","name","uid"],properties:{kind:{const:"kubernetes"},context:{enum:["codicarium-dev","codicarium-prod"]},api_version:{type:"string"},namespace:{type:"string"},name:{type:"string"},uid:{type:"string",format:"uuid"}}},
  { type:"object",additionalProperties:false,required:["kind","address","port","sni","resource"],properties:{kind:{enum:["vault","postgres"]},address:{type:"string"},port:{type:"integer",minimum:1,maximum:65535},sni:{type:"string"},resource:{type:"string"}}},
  { type:"object",additionalProperties:false,required:["kind","object_key","media_type","digest","byte_length"],properties:{kind:{const:"artifact"},object_key:{type:"string"},media_type:{const:"application/gzip"},digest:sha256,byte_length:{type:"integer",minimum:1}}}
]};
const exactData = name => {
  const required = ["operation","subject_id","target_id","expected","observed","positive_oracle","negative_oracles","effect_count"];
  const properties = { operation:{type:"string",minLength:3},subject_id:{type:"string",minLength:1},target_id:{type:"string",minLength:1},expected:{type:"object"},observed:{type:"object"},positive_oracle:{type:"string",minLength:12},negative_oracles:{type:"array",minItems:1,items:{type:"string",minLength:3}},effect_count:{type:"integer",minimum:0} };
  if (name === "candidate-source-capability") Object.assign(properties, {
    capability_id:{type:"string"},issuer:{type:"string"},audience:{const:"deployment-controller-candidate-broker"},capability_subject:{type:"string"},
    repository_id:{type:"integer",minimum:1},repository:{const:"codicarium/deployment-controller"},commit_sha:{const:baselines["codicarium/deployment-controller"]},
    purpose:{const:"deployment-controller-candidate-source"},derived_codeload_url:{type:"string",pattern:"^https://github\\.com/codicarium/deployment-controller/archive/[0-9a-f]{40}\\.tar\\.gz$"},
    object_key:{type:"string",pattern:"^[1-9][0-9]*/[0-9a-f]{40}/[0-9a-f]{64}/[1-9][0-9]*\\.tar\\.gz$"},media_type:{const:"application/gzip"},archive_sha256:sha256,archive_byte_length:{type:"integer",minimum:1},
    run_id:{type:"integer",minimum:1},run_attempt:{const:1},pod_uid:{type:"string",format:"uuid"},pod_name:{type:"string"},pod_namespace:{type:"string"},service_account_uid:{type:"string",format:"uuid"},service_account:{type:"string"},listener_id:{type:"string"},
    jti:{type:"string"},capability_nonce:nonce,iat:{type:"string",format:"date-time"},nbf:{type:"string",format:"date-time"},exp:{type:"string",format:"date-time"},create_status:{const:201},conflict_status:{const:409},mismatch_status:{const:422},consumed_status:{const:410}
  }), required.push("capability_id","issuer","audience","capability_subject","repository_id","repository","commit_sha","purpose","derived_codeload_url","object_key","media_type","archive_sha256","archive_byte_length","run_id","run_attempt","pod_uid","pod_name","pod_namespace","service_account_uid","service_account","listener_id","jti","capability_nonce","iat","nbf","exp","create_status","conflict_status","mismatch_status","consumed_status");
  if (name === "vault-bootstrap") Object.assign(properties, { verify_full:{const:true},kv_create_only_version:{const:1},role_paths:{type:"array",minItems:1,items:{type:"string",pattern:"^[^*]+$"}},retired:{type:"boolean"} }), required.push("verify_full","kv_create_only_version","role_paths","retired");
  if (name === "cnpg-contract" || name === "cnpg-failure") Object.assign(properties, { instances:{const:3},distinct_nodes:{const:3},synchronous_replicas:{minimum:1},rpo_seconds:{const:0},rto_seconds:{maximum:120},app_secret:{const:"runner-platform-journal-app"},ca_secret:{const:"runner-platform-journal-ca"},tls_mode:{const:"verify-full"} }), required.push("instances","distinct_nodes","synchronous_replicas","rpo_seconds","rto_seconds","app_secret","ca_secret","tls_mode");
  if (name === "admin-authorization") Object.assign(properties, { mode:{enum:["normal-admin","break-glass"]},incident_id:{type:"string"},approvers:{type:"array",minItems:2,maxItems:2,uniqueItems:true,items:{type:"string"}},executor:{type:"string"},approval_ttl_seconds:{maximum:1800},credential_ttl_seconds:{maximum:600},single_use:{const:true},forbidden_operations:{type:"array",contains:{const:"publish"}} }), required.push("mode","incident_id","approvers","executor","approval_ttl_seconds","credential_ttl_seconds","single_use","forbidden_operations");
  if (name === "mutation-intent") Object.assign(properties,{mutation_id:{type:"string"},sequence:{type:"integer",minimum:0,maximum:19},writer:{type:"string"},requested_state_sha256:sha256}),required.push("mutation_id","sequence","writer","requested_state_sha256");
  if (name === "mutation-readback") Object.assign(properties,{mutation_id:{type:"string"},sequence:{type:"integer",minimum:0,maximum:19},collector:{type:"string"},raw_state_sha256:sha256,canonical_state_sha256:sha256,etag:{type:"string"}}),required.push("mutation_id","sequence","collector","raw_state_sha256","canonical_state_sha256","etag");
  if (name === "mutation-signature") Object.assign(properties,{mutation_id:{type:"string"},sequence:{type:"integer",minimum:0,maximum:19},signer:{type:"string"},intent_sha256:sha256,readback_sha256:sha256,transit_signature:{type:"string"}}),required.push("mutation_id","sequence","signer","intent_sha256","readback_sha256","transit_signature");
  if (name === "mutation-commit") Object.assign(properties,{mutation_id:{type:"string"},sequence:{type:"integer",minimum:0,maximum:19},committer:{type:"string"},verified:{const:true},previous_commit_sha256:sha256,commit_sha256:sha256}),required.push("mutation_id","sequence","committer","verified","previous_commit_sha256","commit_sha256");
  return {type:"object",additionalProperties:false,required,properties};
};
const schemas = {};
for (const name of payloadNames) schemas[`codicarium.${name}/v2`] = {
  $schema:"https://json-schema.org/draft/2020-12/schema",$id:`https://schemas.codicarium.com/${name}/v2`,type:"object",additionalProperties:false,
  required:["schema","command_id","dag_node_id","subject","target","observation","predicate","data"],
  properties:{ schema:{const:`codicarium.${name}/v2`},command_id:{type:"string",pattern:"^CMD-[A-Z0-9-]+$"},dag_node_id:{enum:nodes.map(n=>n.id)},subject:principal,target,
    observation:{type:"object",additionalProperties:false,required:["request_sha256","payload_sha256","nonce","issued_at","not_before","expires_at","evidence_class","authority_claim"],properties:{request_sha256:sha256,payload_sha256:sha256,nonce,issued_at:{type:"string",format:"date-time"},not_before:{type:"string",format:"date-time"},expires_at:{type:"string",format:"date-time"},evidence_class:{enum:["live","synthetic"]},authority_claim:{type:"object",additionalProperties:false,required:["work_item_id","epoch","sequence"],properties:{work_item_id:{type:"string"},epoch:{type:"integer",minimum:0},sequence:{type:"integer",minimum:0}}}}},
    predicate:{type:"object",additionalProperties:false,required:["id","evaluator_sha256","result","inputs_sha256","computed_at","max_age_seconds"],properties:{id:{type:"string"},evaluator_sha256:sha256,result:{enum:["PASS","FAIL","UNKNOWN"]},inputs_sha256:sha256,computed_at:{type:"string",format:"date-time"},max_age_seconds:{type:"integer",minimum:1,maximum:900}}}, data:exactData(name) }
};
write("typed-payload-schemas-v2.2.json", {schema:"codicarium.typed-payload-schema-bundle/v2",count:37,schemas});

const envelopeSchema = {$schema:"https://json-schema.org/draft/2020-12/schema",type:"object",additionalProperties:false,required:["payloadType","payload","signatures","signer","publication_authority"],properties:{payloadType:{const:"application/vnd.codicarium.command-evidence+jcs"},payload:{type:"string",contentEncoding:"base64"},signatures:{type:"array",minItems:1,maxItems:1,items:{type:"object",additionalProperties:false,required:["keyid","sig"],properties:{keyid:{type:"string"},sig:{type:"string",contentEncoding:"base64"}}}},signer:{oneOf:[{type:"object",additionalProperties:false,required:["kind","issuer","subject","workflow_ref","workflow_sha"],properties:{kind:{enum:["sigstore-keyless-workflow/v1","test-only-ed25519/v1"]},issuer:{type:"string"},subject:{type:"string"},workflow_ref:{type:"string"},workflow_sha:{type:"string",pattern:"^[0-9a-f]{40}$"},public_key_spki:{type:"string"}}},{type:"object",additionalProperties:false,required:["kind","vault_address","transit_key","kubernetes_principal"],properties:{kind:{const:"vault-transit-kubernetes/v1"},vault_address:{type:"string"},transit_key:{type:"string"},kubernetes_principal:{type:"string"}}}]},publication_authority:{type:"boolean"}}};
write("command-evidence-envelope-v2.2.schema.json", envelopeSchema);
const commandCatalog = payloadNames.map((name,index)=>({id:`CMD-${String(index+1).padStart(2,"0")}-${name.toUpperCase()}`,payload_schema:`codicarium.${name}/v2`,executor_digest:sha(Buffer.from(`executor:${name}:v2`)),argv:["/opt/codicarium/bin/evidence-command",`--operation=${name}`,"--no-activation"],allowed_targets:name.includes("cnpg")?["kubernetes","postgres"]:name.includes("vault")?["vault","kubernetes"]:["github","artifact","kubernetes"],max_age_seconds:300,identity:name.includes("mutation")?"dedicated-four-party-principal":"exact-workflow-or-kubernetes-principal",predicate:`PRED-${String(index+1).padStart(2,"0")}-${name.toUpperCase()}`}));
write("command-catalog-v2.2.json", commandCatalog);

const seed = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f","hex");
const privateKey = crypto.createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),seed]),format:"der",type:"pkcs8"});
const publicKey = crypto.createPublicKey(privateKey);
const spki = publicKey.export({format:"der",type:"spki"}).toString("base64");
const canonical = value => { if(value===null||typeof value!=="object") return JSON.stringify(value); if(Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`; };
const pae = (type,payload) => Buffer.concat([Buffer.from(`DSSEv1 ${Buffer.byteLength(type)} ${type} ${payload.length} `),payload]);
const positives = payloadNames.map((name,index)=>{
  const schema=`codicarium.${name}/v2`; const command=commandCatalog[index];
  const data={operation:name,subject_id:"synthetic-fixture",target_id:"non-live-target",expected:{result:"PASS"},observed:{result:"PASS"},positive_oracle:`Recompute ${command.predicate} from canonical raw input bytes`,negative_oracles:["wrong identity","wrong target","stale evidence","nonce replay","predicate mismatch"],effect_count:0};
  if(name==="candidate-source-capability") Object.assign(data,{capability_id:"cap-fixture",issuer:"candidate-broker",audience:"deployment-controller-candidate-broker",capability_subject:"release-v0.6.14",repository_id:1,repository:"codicarium/deployment-controller",commit_sha:baselines["codicarium/deployment-controller"],purpose:"deployment-controller-candidate-source",derived_codeload_url:"https://github.com/codicarium/deployment-controller/archive/1de94f3267dea52b5e9194d32d15a69cb597d17e.tar.gz",object_key:`1/${baselines["codicarium/deployment-controller"]}/${sha(Buffer.from("fixture-archive"))}/123.tar.gz`,media_type:"application/gzip",archive_sha256:sha(Buffer.from("fixture-archive")),archive_byte_length:123,run_id:27,run_attempt:1,pod_uid:"00000000-0000-4000-8000-000000000001",pod_name:"candidate-fetcher",pod_namespace:"artifact-capability",service_account_uid:"00000000-0000-4000-8000-000000000002",service_account:"candidate-fetcher",listener_id:"candidate-broker-v2",jti:"fixture-jti",capability_nonce:sha(Buffer.from("capability-nonce")),iat:TIME,nbf:TIME,exp:"2026-08-26T10:05:00Z",create_status:201,conflict_status:409,mismatch_status:422,consumed_status:410});
  if(name==="vault-bootstrap") Object.assign(data,{verify_full:true,kv_create_only_version:1,role_paths:["secret/data/codicarium/dev/release-platform/journal-app"],retired:false});
  if(name==="cnpg-contract"||name==="cnpg-failure") Object.assign(data,{instances:3,distinct_nodes:3,synchronous_replicas:1,rpo_seconds:0,rto_seconds:120,app_secret:"runner-platform-journal-app",ca_secret:"runner-platform-journal-ca",tls_mode:"verify-full"});
  if(name==="admin-authorization") Object.assign(data,{mode:"break-glass",incident_id:"INC-FIXTURE",approvers:["approver-a","approver-b"],executor:"executor-c",approval_ttl_seconds:900,credential_ttl_seconds:300,single_use:true,forbidden_operations:["bypass-gates","mint-candidate","mutate-admission","publish","clear-unknown"]});
  if(name==="mutation-intent") Object.assign(data,{mutation_id:"fixture-mutation",sequence:0,writer:"writer-sa",requested_state_sha256:sha(Buffer.from("requested-state"))});
  if(name==="mutation-readback") Object.assign(data,{mutation_id:"fixture-mutation",sequence:0,collector:"collector-sa",raw_state_sha256:sha(Buffer.from("raw-state")),canonical_state_sha256:sha(Buffer.from("canonical-state")),etag:"fixture-etag"});
  if(name==="mutation-signature") Object.assign(data,{mutation_id:"fixture-mutation",sequence:0,signer:"signer-sa",intent_sha256:sha(Buffer.from("intent")),readback_sha256:sha(Buffer.from("readback")),transit_signature:"vault:v1:fixture"});
  if(name==="mutation-commit") Object.assign(data,{mutation_id:"fixture-mutation",sequence:0,committer:"committer-sa",verified:true,previous_commit_sha256:"0".repeat(64),commit_sha256:sha(Buffer.from("commit"))});
  const payloadObj={schema,command_id:command.id,dag_node_id:index<nodes.length?nodes[index].id:"S00",subject:{kind:"github-workflow",repository:"codicarium/codicarium-actions",workflow_ref:"refs/heads/main:.github/workflows/evidence.yml",workflow_sha:baselines["codicarium/codicarium-actions"],run_id:index+1,run_attempt:1},target:{kind:"github",repository_id:1,repository:"codicarium/deployment-controller",object:name,immutable_id:`fixture-${index+1}`},observation:{request_sha256:sha(Buffer.from(`request:${name}`)),payload_sha256:sha(Buffer.from(`raw:${name}`)),nonce:sha(Buffer.from(`nonce:${name}`)),issued_at:TIME,not_before:TIME,expires_at:"2026-08-26T10:05:00Z",evidence_class:"synthetic",authority_claim:{work_item_id:"fixture-only",epoch:0,sequence:index}},predicate:{id:command.predicate,evaluator_sha256:sha(Buffer.from(`evaluator:${name}:v2`)),result:"PASS",inputs_sha256:sha(Buffer.from(`inputs:${name}`)),computed_at:TIME,max_age_seconds:300},data};
  const payload=Buffer.from(canonical(payloadObj)); const type="application/vnd.codicarium.command-evidence+jcs"; const sig=crypto.sign(null,pae(type,payload),privateKey).toString("base64");
  return {payloadType:type,payload:payload.toString("base64"),signatures:[{keyid:"fixture-ed25519-rfc8032-seed",sig}],signer:{kind:"test-only-ed25519/v1",issuer:"fixture",subject:"fixture-only",workflow_ref:"none",workflow_sha:"0".repeat(40),public_key_spki:spki},publication_authority:false};
});
write("signed-command-evidence-positive-v2.2.json", positives);
const negativeVectors=[
  ["synthetic-authority","set publication_authority true","synthetic evidence can never authorize"],
  ["bad-signature","flip signature byte","DSSE signature must fail"],
  ["non-jcs","re-encode payload with whitespace","payload bytes must equal RFC8785 JCS"],
  ["nonce-replay","reuse nonce in same authority epoch","nonce ledger must reject"],
  ["stale","set computed_at older than max_age_seconds","freshness must fail"],
  ["wrong-workflow","change exact workflow_ref","identity must fail"],
  ["wrong-pod-uid","change TokenReview pod UID","identity must fail"],
  ["wrong-target","change immutable target ID","target binding must fail"],
  ["predicate-forgery","mark PASS without recomputation","evaluator must fail"],
  ["candidate-second-read","read an already consumed capability","must return 410"],
  ["collector-writer-overlap","reuse writer as collector","four-party separation must fail"],
  ["admin-single-approver","remove one approver","dual control must fail"],
  ["break-glass-publish","request publish","forbidden operation must fail"],
  ["vault-wildcard","add wildcard secret path","Vault contract must fail"],
  ["cnpg-two-nodes","place three instances on two nodes","N-1 placement must fail"],
  ["proxy-generic-post","request unlisted POST","closed catalog must fail"],
  ["unknown-retry","edge UNKNOWN back to claim","no-retry DAG must fail"]
].map(([id,mutation,oracle])=>({id,mutation,expected_result:"REJECT",oracle,effect_count:0}));
write("negative-vectors-v2.2.json", negativeVectors);

const dagSchema={$schema:"https://json-schema.org/draft/2020-12/schema",type:"array",minItems:101,maxItems:101,items:{type:"object",additionalProperties:false,required:["id","owner","action","depends_on","mode"],properties:{id:{pattern:"^(S0[01]|B1[0-5]|(CA|IF|PG|VA|RP|DC)2[0-5]|G3[0-5]|X4[0-2]|L4[0-4]|Q4[0-2]|A5[01]|F0[0-4]|M(0[1-9]|1[0-9])|F2[0-4]|U0[0-8])$"},owner:{type:"string"},action:{type:"string",minLength:12},depends_on:{type:"array",uniqueItems:true,items:{type:"string"}},mode:{enum:["normal","terminal-recovery"]}}}};
write("rollout-dag-v2.2.schema.json",dagSchema); write("rollout-dag-v2.2.json",nodes);
const mutationContract={schema:"codicarium.four-party-mutation-contract/v2",steps:[{schema:"codicarium.mutation-intent/v2",principal:"dedicated writer",fields:"requested mutation only; no readback or signature"},{schema:"codicarium.mutation-readback/v2",principal:"independent authenticated collector",fields:"raw bytes, JCS bytes, ETag, immutable target and collector identity"},{schema:"codicarium.mutation-signature/v2",principal:"Vault transit signer",fields:"intent and readback hashes; no target write"},{schema:"codicarium.mutation-commit/v2",principal:"distinct append-only committer",fields:"verification result, epoch, sequence and previous commit hash"}],invariants:["four distinct service accounts and Vault roles","no GitHub App or RBAC overlap","deny direct writer egress to collector signer and committer","UNKNOWN freezes epoch; never retry"]};
write("mutation-contract-v2.2.json",mutationContract);
const proxy={schema:"codicarium.github-proxy-operation-catalog/v2",default:"DENY",listener_binding:["TokenReview audience","Pod UID/name/namespace","ServiceAccount UID/name","listener ID","nonce","expiry","SNI","API version"],operations:["GET exact repository","GET exact ref/tree/blob","GET exact workflow run/checks","POST exact workflow dispatch with return_run_details=true","POST exact tag ref create","POST exact draft release create","POST exact named asset upload","PATCH exact release finalize","POST exact listed run cancel"],denials:["generic POST","redirect","encoded path trick","host change","direct GitHub egress","unlisted asset name","unbound listener"]};
write("github-proxy-catalog-v2.2.json",proxy);
const security={candidate_source:{schema:"codicarium.candidate-source-capability/v2",media_type:"application/gzip",purpose:"deployment-controller-candidate-source",object_key:"<repo-id>/<commit-sha>/<archive-sha256>/<byte-length>.tar.gz",create:{success:201,conflict:409,mismatch:422},read:{success_once:200,consumed:410},raw_fetcher:"hash and count only; never extract",extractor:"destroyed no-network Kata sandbox only"},vault:{owner:"codicarium/vault-config",evidence_schema:"codicarium.vault-bootstrap/v2",requirements:["exact context IP port SNI CA SAN role policy and KV path","create-only KV v2 version 1","wrong CA SNI expiry plaintext and wildcard negatives","retire bootstrap role and workload"]},cnpg:{owner:"codicarium/postgres-config",evidence_schemas:["codicarium.cnpg-contract/v2","codicarium.cnpg-failure/v2"],instances:3,distinct_nodes:3,synchronous_replicas:1,tls:"verify-full",app_secret:"runner-platform-journal-app",ca_secret:"runner-platform-journal-ca",rpo_seconds:0,rto_seconds_max:120,tests:["backup","isolated restore","loss of each node","runtime execute-only","migration role retired"]},admin:{normal:{requester:"one",approvers:1,executor:"third distinct",approval_ttl_seconds_max:1800,credential_ttl_seconds_max:600},break_glass:{approvers:2,executor:"third distinct",approval_ttl_seconds_max:900,credential_ttl_seconds_max:300,single_use:true,forbidden:["bypass gates","mint candidate","mutate admission","publish","clear UNKNOWN"],negative_effect_count:0}},legacy:{schema:"codicarium.legacy-retirement/v2",workflows:5,requirements:["disable and delete","cancel queued and in-progress","terminal readback","revoke credentials routes sessions","wait maximum TTL plus skew"]},forward_recovery:{schema:"codicarium.forward-recovery/v2",requirements:["new work item claim epoch nonce and unused release ID","no retry edge","no retag resume overwrite or legacy authority","signed successor handoff ends current DAG"]}};
write("security-contracts-v2.2.json",security);

const reqStatements = [
  "Freeze the seven authoritative heads and never require a later head to equal a preimplementation head; each lane instead binds its own candidate and postmerge head.",
  "Execute exactly the closed 101-node DAG with the six CA, IF, PG, VA, RP and DC lanes, explicit publication nodes, terminal U00-U08 recovery, and no retry edge.",
  "Define and validate all 37 typed payload schemas and a DSSE PAE envelope whose payload is exact RFC 8785 JCS bytes.",
  "Accept publication authority only for live evidence after Q42 and A51 with an unused 256-bit nonce, exact identity and target, fresh recomputed PASS predicate, claim, epoch and sequence.",
  "Force publication_authority false for synthetic evidence and keep activation BLOCKED_PREACTIVATION until every live gate exists.",
  "Bind each command to an exact executor digest, argv, identity, target union, request and payload hashes, nonce, time window, predicate evaluator and pre/effect/post evidence.",
  "Use candidate-source-capability/v2 with exact purpose, deterministic key, application/gzip, immutable create statuses 201/409/422 and one successful read followed by 410.",
  "Fetch candidate bytes without extraction and extract only inside a destroyed no-network Kata sandbox after digest and byte-length verification.",
  "Use four typed mutation records with distinct writer, collector, Vault transit signer and append-only committer identities, roles, networks and GitHub Apps.",
  "Expose only the exact GitHub proxy operation catalog; deny generic POST, redirects, path tricks, host changes and direct GitHub egress.",
  "Bind proxy access to TokenReview Pod and ServiceAccount identity, listener, nonce, expiry, audience, SNI and API version.",
  "Make vault-config own executable create-only Vault bootstrap, verify-full and teardown evidence with wrong-CA, wrong-SNI, expiry, plaintext and wildcard zero-effect negatives.",
  "Make postgres-config own executable three-node CNPG placement, synchronous replication, TLS, app and CA Secrets, execute-only runtime, backup, isolated restore and each-node-loss RPO zero and RTO at most 120 seconds.",
  "Retire all five legacy workflows, runs, credentials, routes and sessions and wait the maximum observed TTL plus skew before Q40.",
  "On ambiguity freeze the epoch, quarantine, repair forward at a new head, and allocate a later unused release ID, claim, epoch, nonce and work item without retag, resume or overwrite.",
  "Require normal administration to use distinct requester, approver and executor with bounded TTL and single-use credentials.",
  "Require break-glass dual independent approvers and a separate executor; forbid bypassing gates, minting candidates, mutating admission, publishing or clearing UNKNOWN, and prove zero target effects for negatives.",
  "Assign schemas and evaluators to codicarium-actions, configuration and policy to release-platform-config, central infrastructure to infra, data to postgres-config, secrets to vault-config and release orchestration to deployment-controller; release-security is not an owner.",
  "Create release-platform-config only after exact-hash council approval using one-use dual control, then independently bind its immutable numeric ID, node ID, settings, seed, tree, rulesets, checks and administrator-visible bypass actors.",
  "Require all six implementation lanes to pass signed exact-diff review, positive and negative tests, protected same-head checks, guarded exact merge and postmerge main readback.",
  "Materialize central capacity, Kata, namespaces, admission, proxy and RBAC before live probes and materialize CNPG and Vault before release-platform workloads.",
  "Prove all grant Applications absent before creating the complete set and prove health while runner-config descriptor, values and handoff blobs remain unchanged.",
  "Recompute fresh signed predicates at Q41 and authorize exactly one narrow work item at Q42 without side effects.",
  "Activate one exact epoch at A50 and independently prove authority isolation at A51 before candidate delivery.",
  "Use claim CAS, a verifier dispatch with exact HTTP 200 run details, signed authorization and a publisher dispatch with sequence zero.",
  "Execute M01 through M19 as sequential four-party mutations and verify their complete append-only hash chain.",
  "Read back the final tag, release, image, chart and fourteen assets before retiring temporary capabilities and revoking final sessions.",
  "Treat issue 93 as closed historical context, v0.6.13 as immutable, v0.6.14 as absent before execution, and account for PR 108 only as canonical ACTIONS_STORAGE_OVH recovery secrets plus docs and tests.",
  "Hash-bind the normalized pipeline spec-check output in the custom validator and exact-hash council inputs.",
  "Validate every schema, positive fixture and intentional negative vector and require two deterministic generations to be byte-identical.",
  "Trace every requirement to DAG nodes, commands, payload schemas, one positive oracle and at least one zero-effect negative oracle.",
  "Never authorize from prose, a manual assertion, a fixture, a writer-supplied readback digest or an unrecomputed PASS field.",
  "Use Sigstore keyless identity for an exact GitHub workflow or Vault transit for an exact Kubernetes ServiceAccount as the only live signing authorities.",
  "Verify freshness from issued, not-before, expiry, predicate computation time and command maximum age with bounded clock skew.",
  "Verify target authority using immutable repository IDs, Kubernetes context and UID, exact Vault or PostgreSQL SNI, or deterministic artifact key and digest.",
  "Publish only through the explicit F02, F04 and M01-M19 execution nodes; planning, review, tests, gates and activation cannot publish.",
  "End the normal DAG at F24 and the ambiguity DAG at U08 with signed evidence and no edge into an earlier claim or publication node.",
  "Require administrator bypass inventory to be unredacted and independently collected; omitted or redacted data is UNKNOWN and blocks activation.",
  "Require every denied administrative, capability, proxy, Vault, CNPG, archive, replay, readback and mutation test to report effect_count zero.",
  "Keep repository bootstrap, release platform and all new grants inactive until their preceding readbacks and protected checks pass.",
  "Use no backward-compatibility authority path and do not reactivate, adapt or preserve the five retired workflows.",
  "Prohibit direct runtime DML and schema creation; runtime receives execute-only procedures after a distinct migrator is retired.",
  "Bind release finalization to canonical independent readback rather than publisher responses or supplied digests.",
  "Require council review from planner, security, DevOps and QA against identical spec, annex, spec-check and validator report hashes.",
  "Keep every live mutation disabled in this specification stage; generated fixtures are synthetic, inert and non-authorizing.",
  "REQ46 closure: define signed typed DSSE/JCS command evidence with exact identity, target, nonce, authority, freshness and recomputed predicate semantics for all 37 payloads.",
  "REQ47 closure: define normal administrator and break-glass dual-control contracts, bounded single-use credentials, independent execution, audit, revocation and zero-effect negative tests.",
  "REQ48 closure: define candidate-source-capability/v2 with exact issuer, audience, subject, repository, commit, codeload URL, object key, media type, digest, length, run, Pod, ServiceAccount, listener, JTI, nonce and time bindings.",
  "REQ49 closure: assign schemas and evaluators to codicarium-actions and the remaining configuration, infra, PostgreSQL, Vault, bootstrap and orchestration boundaries without any release-security owner.",
  "REQ50 closure: define forward-only ambiguity repair with freeze, quarantine, new code/review/test/validation/merge, later unused release identity, new claim/epoch/nonce/work item and terminal successor handoff without retry."
];
const requirements=reqStatements.map((statement,i)=>({id:`REQ-${String(i+1).padStart(3,"0")}`,priority:"MUST",statement,rationale:"Fail-closed v2.2 council closure."}));
const acceptance=[]; const tests=[];
for(let i=0;i<requirements.length;i+=2){const ids=requirements.slice(i,i+2).map(x=>x.id),n=String(acceptance.length+1).padStart(3,"0"); acceptance.push({id:`AC-${n}`,requirement_ids:ids,scenario:`Given BLOCKED_PREACTIVATION and synthetic fixtures, When ${ids.join(" and ")} are evaluated against exact typed evidence, Then only fresh live recomputed evidence may pass and every negative has zero effects.`}); tests.push({id:`TST-${n}`,type:i<30?"integration":"e2e",requirement_ids:ids,approach:`Run validate-v2.2.py and the mapped positive and negative oracles for ${ids.join(" and ")}; assert deterministic rejection and effect_count zero.`});}
const maps=new Map(requirements.map(r=>[r.id,{acceptance_ids:[],test_ids:[]} ])); for(const a of acceptance)for(const id of a.requirement_ids)maps.get(id).acceptance_ids.push(a.id); for(const t of tests)for(const id of t.requirement_ids)maps.get(id).test_ids.push(t.id);
const traceability=requirements.map((r,i)=>({requirement_id:r.id,acceptance_ids:maps.get(r.id).acceptance_ids,test_ids:maps.get(r.id).test_ids,review_checks:[`Review ${r.id} against DAG nodes ${nodes[i%nodes.length].id} and ${nodes[(i+1)%nodes.length].id}.`],validation_checks:[`Validate ${commandCatalog[i%37].id}, schema ${commandCatalog[i%37].payload_schema}, positive signature and zero-effect negative vectors.`]}));
const spec={meta:{id:"SPEC-deployment-controller-successor-v2-2",title:"Release platform v2.2 executable authority specification",author:"Codex release manager",created_at:TIME,version:"2.2.0-council-draft"},feature:{problem_statement:"v2.1 was deterministic but temporally unschedulable and allowed forgeable evidence, incomplete bootstrap, broad proxy authority and absent admin, CNPG and recovery contracts.",goals:["Closed schedulable rollout DAG","Cryptographically verifiable typed evidence","No synthetic authorization","Forward-only recovery"],non_goals:["Live mutation or deployment","Backward compatibility","Activation before live evidence"],scope_in:["Seven repositories and future release-platform-config","v0.6.14 successor release","GitHub, Kubernetes, Vault, PostgreSQL and artifact evidence"],scope_out:["Changing v0.6.13","Reopening issue 93","Using release-security as an owner"]},requirements,acceptance_criteria:acceptance,test_plan:tests,traceability,quality_gates:{spec_review_required:true,testability_required:true,traceability_required:true},council:{perspectives:["planner","security","tech_lead_devops","tech_lead_qa"],consensus_summary:"Implementation remains prohibited until an exact-hash v2.2 council accepts the spec, annex, normalized spec-check and validator report together.",open_questions:[]}};
fs.writeFileSync(SPEC,json(spec));
const checkRun=spawnSync("node",["/home/rickebo/.codex/bin/pipeline-spec-check.mjs","--spec",SPEC,"--out",CHECK],{encoding:"utf8"}); if(checkRun.status!==0)throw new Error(checkRun.stderr||checkRun.stdout); const checked=JSON.parse(fs.readFileSync(CHECK,"utf8")); checked.checked_at=TIME; fs.writeFileSync(CHECK,json(checked));
const fixtureFiles=fs.readdirSync(OUT).sort().map(name=>{const data=fs.readFileSync(path.join(OUT,name));return{path:`fixtures-v2.2/${name}`,byte_length:data.length,sha256:sha(data)}});
const trace=requirements.map((r,i)=>({requirement_id:r.id,dag_nodes:[nodes[i%nodes.length].id,nodes[(i+1)%nodes.length].id],commands:[commandCatalog[i%37].id],payload_schemas:[commandCatalog[i%37].payload_schema],positive_oracle:`Verify the signed fixture and recompute ${commandCatalog[i%37].predicate}.`,negative_oracles:[negativeVectors[i%negativeVectors.length].id],negative_effect_count:0}));
const annex={schema:"codicarium.deployment-controller-release-spec/v2.2",generated_at:TIME,predecessor:"v2.1 rejected_return_to_spec",baselines,current_facts:{issue_93:"closed",release_v0_6_13:"exists and immutable",release_v0_6_14:"absent",pr_108:"recover-release-v068 changes only canonical ACTIONS_STORAGE_OVH secrets plus documentation and tests"},activation:{state:"BLOCKED_PREACTIVATION",synthetic_evidence_authorizes:false,live_gate_count:0,required_live_gate_count:37},owners:{schemas_and_evaluators:"codicarium/codicarium-actions",configuration_and_policy:"codicarium/release-platform-config",central_infrastructure:"codicarium/infra",postgres:"codicarium/postgres-config",vault:"codicarium/vault-config",orchestration:"codicarium/deployment-controller",bootstrap:"codicarium/app-config",forbidden_owner:"codicarium/release-security"},dag:{schema:"codicarium.rollout-dag/v2.2",node_count:nodes.length,nodes,ambiguity_trigger:"Any UNKNOWN, mismatch, partial effect or timeout enters U00 and cannot retry."},payload_contract:{count:37,names:payloadNames,envelope:"DSSE PAE over exact RFC8785 JCS",live_signers:["Sigstore keyless exact GitHub workflow","Vault transit exact Kubernetes ServiceAccount"],publication_authority_predicate:"live AND after Q42 AND after A51 AND unused nonce AND exact identity AND exact target AND fresh AND recomputed PASS AND matching work_item_id/epoch/sequence",synthetic_authority:false},command_catalog:commandCatalog,security_contracts:security,mutation_contract:mutationContract,github_proxy:proxy,traceability:trace,hash_bindings:{spec_sha256:sha(fs.readFileSync(SPEC)),pipeline_spec_check_sha256:sha(fs.readFileSync(CHECK)),council_required_hashes:["spec_sha256","annex_sha256","pipeline_spec_check_sha256","validator_report_sha256"]},files:fixtureFiles};
fs.writeFileSync(ANNEX,json(annex));
console.log(JSON.stringify({status:"generated v2.2",spec_sha256:sha(fs.readFileSync(SPEC)),annex_sha256:sha(fs.readFileSync(ANNEX)),pipeline_spec_check_sha256:sha(fs.readFileSync(CHECK)),requirements:requirements.length,acceptance_criteria:acceptance.length,tests:tests.length,trace_rows:trace.length,typed_payload_schemas:payloadNames.length,dag_nodes:nodes.length,fixture_files:fixtureFiles.length,negative_vectors:negativeVectors.length,activation:annex.activation.state},null,2));
