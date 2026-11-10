#!/usr/bin/env python3
"""Trusted existing-publisher integration; never starts/retries a Jenkins build.

The admin-reviewed EnvInject cause parser supplies numeric RELEASE_EVENT_ACTOR;
this must NOT be a build parameter, repository value or caller-controlled model
argument. Manual UserIdCause and positively authenticated non-nightshift actors
preserve the existing path. Missing webhook actors and cross-project bots fail.

prepare() runs in the trusted controller, validates (does NOT consume) a signed
MR ticket and creates an immutable private context. admit_prepared() runs only at
the actual existing deployment write boundary and consumes the ticket once.
Key/read-token mounts must never reach source, Maven/npm or image-build workers.
Controller/deploy are trusted same-UID principals; this is NOT an OS sandbox.
Admission cannot cancel a write after it starts. See nightshift-gate.py limits.

V2 tickets approve S/T/tree E, not the unknown future merge commit M. prepare()
checks authenticated GitLab commit M parent_ids=[T,S]; GitLab commit API has NO
trusted tree_id field. Exact tree proof and full-verify audit for M are mandatory
at admission, supplied by trusted fixed-git/local-object + audit code, never by
model/build parameters. V2 preparation only reports proofPending, not test success.
The generator must force full-verify and bind the actual M audit to immutable
commit_proof before patch. Admission returns mergeVerification evidence only after
signature, local proof, full verification and single-use admission all succeed.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import sys
import urllib.parse
import urllib.request

ROOT = Path('/var/lib/jenkins/superagent-nightshift')
ASSETS = ROOT / 'assets'
ROUTES = ROOT / 'routes.json'
KEY = ROOT / 'signing.key'
STATE = ROOT / 'replay'
PREPARED = ROOT / 'prepared'
GATE_SHA256 = '319878487367c209dbc80532fe46354dd05e1bcc1bbb5243409513e96fc01388'
BOT_IDS = frozenset(range(95, 112))
BLOCK_OPEN = '<!-- superagent-deploy-v1\n'
BLOCK_CLOSE = '\n-->'
MAX_JSON = 262144
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z')
SHA = re.compile(r'[0-9a-f]{40}\Z')
PROJECT_PATH = re.compile(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+\Z')


class HookDenied(Exception):
    """Only fixed nonsecret denial reasons cross the publisher boundary."""


def require(ok, code):
    if not ok:
        raise HookDenied(code)


def load_gate():
    path = Path(__file__).resolve().with_name('nightshift-gate.py')
    require(not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == GATE_SHA256, 'gate_module_pin_mismatch')
    spec = importlib.util.spec_from_file_location('_nightshift_publisher_gate', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate_json_key')
            result[key] = value
        return result
    try:
        require(len(raw) <= MAX_JSON, 'oversized_json')
        return json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda _: (_ for _ in ()).throw(HookDenied('invalid_json')))
    except (ValueError, UnicodeError, RecursionError):
        raise HookDenied('invalid_json') from None


def public_context(env):
    kind = env.get('RELEASE_TRIGGER_KIND')
    actor = env.get('RELEASE_EVENT_ACTOR', '')
    if kind == 'manual':
        require(not any(env.get(key) for key in ('RELEASE_EVENT_ACTOR', 'RELEASE_EVENT_SHA', 'RELEASE_EVENT_PROJECT', 'RELEASE_EVENT_REF', 'RELEASE_EVENT_PATH', 'RELEASE_EVENT_SOURCE')), 'manual_event_conflict')
        return {'version': 1, 'mode': 'manual'}
    require(kind == 'master-push', 'untrusted_trigger_kind')
    require(type(actor) is str and re.fullmatch(r'[1-9][0-9]{0,15}', actor), 'missing_trusted_actor')
    require(type(env.get('RELEASE_EVENT_PROJECT')) is str and re.fullmatch(r'[1-9][0-9]{0,15}', env['RELEASE_EVENT_PROJECT']), 'invalid_project')
    require(type(env.get('RELEASE_EVENT_SHA')) is str and SHA.fullmatch(env['RELEASE_EVENT_SHA']) and env['RELEASE_EVENT_SHA'] != '0' * 40, 'invalid_sha')
    require(env.get('RELEASE_EVENT_REF') == 'refs/heads/master', 'invalid_ref')
    require(type(env.get('RELEASE_EVENT_PATH')) is str and PROJECT_PATH.fullmatch(env['RELEASE_EVENT_PATH']), 'invalid_project_path')
    require(type(env.get('JOB_NAME')) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}', env['JOB_NAME']), 'invalid_job')
    require(type(env.get('BUILD_NUMBER')) is str and re.fullmatch(r'[1-9][0-9]{0,15}', env['BUILD_NUMBER']), 'invalid_build')
    common = dict(version=1, actorId=int(actor), projectId=int(env['RELEASE_EVENT_PROJECT']), projectPath=env['RELEASE_EVENT_PATH'], sourceSha=env['RELEASE_EVENT_SHA'], job=env['JOB_NAME'], buildId=env['BUILD_NUMBER'], environment='test', gitlabOrigin=env.get('RELEASE_EVENT_SOURCE'))
    if int(actor) not in BOT_IDS:
        # Trust is provided by reviewed GenericCause extraction, not inferred from
        # arbitrary input; no route file, API credential or HMAC key is read here.
        return dict(common, mode='human')
    return dict(common, mode='nightshift')


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise HookDenied('gitlab_redirect_denied')


def api_get(origin, path, token):
    require(path.startswith('/api/v4/') and not re.search(r'[\r\n]', path), 'invalid_api_route')
    request = urllib.request.Request(origin + path, method='GET', headers={'PRIVATE-TOKEN': token, 'Accept': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(request, timeout=10) as response:
            require(response.status == 200 and response.geturl() == origin + path, 'gitlab_response_denied')
            raw = response.read(MAX_JSON + 1)
            return strict_json(raw), response.headers.get('X-Next-Page')
    except HookDenied:
        raise
    except Exception:
        raise HookDenied('gitlab_read_failed') from None


def target_identity(value):
    require(type(value) is dict and set(value) == {'namespace', 'deployment', 'container'}, 'invalid_target_identity')
    require(all(type(item) is str and len(item) <= 253 and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', item) for item in value.values()), 'invalid_target_identity')
    return {key: value[key] for key in ('namespace', 'deployment', 'container')}


def route_for(context, routes):
    require(type(routes) is dict and routes.get('version') == 1 and type(routes.get('projects')) is dict, 'invalid_routes')
    require(routes.get('keyFile') == str(KEY) and routes.get('stateDir') == str(STATE), 'unapproved_secret_state_route')
    require(type(routes.get('keyId')) is str and ID.fullmatch(routes['keyId']), 'invalid_key_id')
    origin = routes.get('gitlabOrigin')
    require(origin in ('https://gitlab.yk.ykgtxy.com', 'http://gitlab.yk.ykgtxy.com') and context['gitlabOrigin'] == origin, 'wrong_gitlab_origin')
    # Plain HTTP is only the exact explicitly reviewed internal host, never a
    # fallback redirect or arbitrary endpoint. It does not provide TLS secrecy.
    project = routes['projects'].get(str(context['projectId']))
    require(type(project) is dict and type(project.get('botUserId')) is int and project['botUserId'] in BOT_IDS and project['botUserId'] == context['actorId'] and project.get('path') == context['projectPath'], 'wrong_project_bot')
    require(sum(1 for item in routes['projects'].values() if type(item) is dict and item.get('botUserId') == context['actorId']) == 1, 'ambiguous_bot_route')
    job = project.get('jobs', {}).get(context['job'])
    require(type(job) is dict and type(job.get('destinationId')) is str and ID.fullmatch(job['destinationId']), 'unapproved_job_destination')
    target_identity({key: job.get(key) for key in ('namespace', 'deployment', 'container')})
    credential = project.get('readCredentialFile')
    require(type(credential) is str and Path(credential).parent == ROOT / 'read-credentials' and Path(credential).name == str(context['projectId']) + '.json', 'unapproved_read_credential')
    return project, job


def envelope_from_description(description, context):
    require(type(description) is str and len(description.encode()) <= MAX_JSON, 'invalid_mr_description')
    require(description.count(BLOCK_OPEN) == 1 and description.count('<!-- superagent-deploy-v1') == 1, 'ambiguous_metadata_block')
    start = description.index(BLOCK_OPEN) + len(BLOCK_OPEN)
    end = description.find(BLOCK_CLOSE, start)
    require(end >= start, 'invalid_metadata_block')
    envelopes = strict_json(description[start:end])
    require(type(envelopes) is list and 1 <= len(envelopes) <= 32, 'invalid_envelopes')
    jobs = []
    for envelope in envelopes:
        require(type(envelope) is dict and set(envelope) == {'payload', 'signature'} and type(envelope['payload']) is dict, 'invalid_envelope')
        job = envelope['payload'].get('jobs')
        require(type(job) is list and len(job) == 1 and type(job[0]) is str, 'invalid_ticket_jobs')
        jobs.append(job[0])
    require(len(set(jobs)) == len(jobs) and jobs.count(context['job']) == 1, 'ambiguous_job_ticket')
    ticket = envelopes[jobs.index(context['job'])]
    payload = ticket['payload']
    marker_sha = payload.get('sourceSha') if payload.get('version') == 2 else context['sourceSha']
    require(type(marker_sha) is str and SHA.fullmatch(marker_sha), 'invalid_marker_source')
    marker = 'nightshift:' + str(payload.get('taskId', '')) + ':' + context['projectPath'].rsplit('/', 1)[-1] + ':' + marker_sha
    markers = re.findall(r'nightshift:[A-Za-z0-9._:-]+:[A-Za-z0-9_-]+:[0-9a-f]{40}', description)
    require(markers == [marker], 'mr_marker_mismatch')
    return ticket


def prepare(env, *, trusted_target=None, routes_file=ROUTES, getter=api_get, now=None):
    """Controller-only pure-ticket validation plus immutable context creation.

    No replay marker is consumed. routes_file/getter/now are trusted test seams,
    never populated from build parameters. Production patches use fixed defaults.
    """
    context = public_context(env)
    if context['mode'] != 'nightshift':
        return context
    gate = load_gate()
    routes = strict_json(gate._private_read(str(routes_file), MAX_JSON))
    project, job = route_for(context, routes)
    actual_target = target_identity(trusted_target)
    route_target = target_identity({key: job[key] for key in ('namespace', 'deployment', 'container')})
    require(actual_target == route_target, 'prepare_target_mismatch')
    # The immutable private snapshot ties the signed destinationId to the exact
    # operator-reviewed namespace/deployment/container, never model job prose.
    context = dict(context, target=route_target)
    credential = strict_json(gate._private_read(project['readCredentialFile'], 16384))
    require(type(credential) is dict and credential.get('projectId') == context['projectId'] and type(credential.get('token')) is str and re.fullmatch(r'[\x21-\x7e]{8,4096}', credential['token']), 'invalid_read_credential')
    require(gate._time(credential.get('expiresAt')) > (now or datetime.now(timezone.utc)), 'expired_read_credential')
    # Reporter/read_api provisioning is operator-owned; this file's identity and
    # expiry checks do not invent a server-side scope introspection guarantee.
    origin, token = routes['gitlabOrigin'], credential['token']
    prefix = '/api/v4/projects/' + str(context['projectId'])
    metadata, _ = getter(origin, prefix, token)
    require(type(metadata) is dict and metadata.get('id') == context['projectId'] and metadata.get('path_with_namespace') == context['projectPath'] and metadata.get('default_branch') == 'master', 'gitlab_project_mismatch')
    associated = []
    for page in range(1, 11):
        items, next_page = getter(origin, prefix + '/repository/commits/' + context['sourceSha'] + '/merge_requests?per_page=100&page=' + str(page), token)
        require(type(items) is list and all(type(item) is dict for item in items), 'invalid_mr_list')
        associated.extend(items)
        if next_page == '' or (next_page is None and len(items) < 100):
            break
        require(next_page in (None, str(page + 1)) and page < 10, 'mr_pagination_incomplete')
    matches = [mr for mr in associated if mr.get('author', {}).get('id') == context['actorId'] and mr.get('state') == 'merged' and mr.get('merge_commit_sha') == context['sourceSha']]
    require(len(matches) == 1 and type(matches[0].get('iid')) is int and matches[0]['iid'] > 0, 'ambiguous_merged_mr')
    mr, _ = getter(origin, prefix + '/merge_requests/' + str(matches[0]['iid']), token)
    require(type(mr) is dict and mr.get('iid') == matches[0]['iid'] and mr.get('author', {}).get('id') == context['actorId'] and mr.get('source_project_id') == mr.get('target_project_id') == context['projectId'] and mr.get('state') == 'merged' and mr.get('merge_commit_sha') == context['sourceSha'] and mr.get('target_branch') == 'master' and re.fullmatch(r'(?:sdd|agent)/[A-Za-z0-9._/-]+', mr.get('source_branch', '')), 'merged_mr_identity_mismatch')
    ticket = envelope_from_description(mr.get('description'), context)
    payload = ticket['payload']
    proof_fields = {}
    if type(payload.get('version')) is int and payload['version'] == 2:
        require(mr.get('sha') == payload.get('sourceSha'), 'merged_mr_source_mismatch')
        # Authenticated commit API supplies parents, NOT an exact Git tree object ID.
        commit, _ = getter(origin, prefix + '/repository/commits/' + context['sourceSha'], token)
        require(type(commit) is dict and commit.get('id') == context['sourceSha']
                and type(commit.get('parent_ids')) is list and len(commit['parent_ids']) == 2
                and all(type(parent) is str and SHA.fullmatch(parent) for parent in commit['parent_ids']), 'invalid_merge_commit')
        proof_fields = dict(approved_source_sha=payload.get('sourceSha'), target_sha=payload.get('targetSha'),
                            parents=tuple(commit['parent_ids']))
    else:
        require(mr.get('sha') == context['sourceSha'], 'merged_mr_identity_mismatch')
    expected = gate.GateContext(job=context['job'], build_id=context['buildId'], source_sha=context['sourceSha'], project_id=context['projectId'], destination_id=job['destinationId'], environment='test', key_id=routes['keyId'], **proof_fields)
    key = gate._private_read(str(KEY), gate.MAX_KEY_BYTES)
    checked = (gate.validate_preparation if proof_fields else gate.validate)(ticket, key, expected, now or datetime.now(timezone.utc))
    if proof_fields:
        context = dict(context, ticketVersion=2, approvedSourceSha=payload['sourceSha'], targetSha=payload['targetSha'],
                       expectedTreeSha=payload['expectedTreeSha'], parents=list(expected.parents),
                       validationProfile=payload['validationProfile'], proofPending=True)
    document = dict(version=1, context=dict(context, keyId=routes['keyId'], destinationId=job['destinationId'], mergeRequestIid=mr['iid']), ticket=ticket)
    basename = hashlib.sha256(gate.canonical([context['projectId'], context['job'], context['buildId'], context['sourceSha']])).hexdigest() + '.json'
    directory = gate._directory(gate._parts(str(PREPARED)), private=True)
    try:
        fd = os.open(basename, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=directory)
        try:
            with os.fdopen(fd, 'wb', closefd=False) as stream:
                stream.write(gate.canonical(document) + b'\n'); stream.flush(); os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(directory)
    except OSError:
        raise HookDenied('prepared_context_exists_or_unavailable') from None
    finally:
        os.close(directory)
    return dict(context, contextPath=str(PREPARED / basename), keyId=routes['keyId'], destinationId=job['destinationId'], admissionDeadline=checked['admissionDeadline'])


def admit_prepared(prepared, expected, *, commit_proof=None, now=None):
    """Consume at write boundary; v2 commit_proof comes ONLY from trusted local Git/audit.

    commit_proof={sha:M, parents:[T,S], treeSha:E,
                  verification:{source:M, profile:'full-verify', passed:True}}.
    Never copy it from model arguments, build parameters or an untrusted report.
    V1 needs no new proof and retains its exact SHA contract.
    """
    require(type(prepared) is dict and prepared.get('version') == 1 and prepared.get('mode') in ('manual', 'human', 'nightshift'), 'missing_prepared_identity')
    if prepared['mode'] in ('manual', 'human'):
        if prepared['mode'] == 'human':
            require(type(prepared.get('actorId')) is int and prepared['actorId'] > 0 and prepared['actorId'] not in BOT_IDS, 'invalid_human_actor')
        return {'allowed': True, 'gated': False, 'mode': prepared['mode']}
    require(type(expected) is dict and set(expected) == {'job', 'buildId', 'sourceSha', 'projectId', 'environment', 'target'}, 'invalid_deploy_context')
    actual_target = target_identity(expected['target'])
    require(target_identity(prepared.get('target')) == actual_target, 'deploy_target_mismatch')
    require(all(prepared.get(key) == value for key, value in expected.items()) and expected['environment'] == 'test', 'deploy_context_mismatch')
    require(type(prepared.get('actorId')) is int and prepared['actorId'] in BOT_IDS, 'invalid_bot_actor')
    path = prepared.get('contextPath')
    require(type(path) is str and Path(path).parent == PREPARED and re.fullmatch(r'[0-9a-f]{64}\.json', Path(path).name), 'unsafe_prepared_path')
    gate = load_gate()
    document = strict_json(gate._private_read(path, MAX_JSON))
    context = document.get('context', {})
    require(document.get('version') == 1 and context.get('mode') == 'nightshift' and all(context.get(key) == prepared.get(key) for key in ('actorId', 'projectId', 'projectPath', 'sourceSha', 'job', 'buildId', 'environment', 'gitlabOrigin', 'keyId', 'destinationId', 'target')), 'prepared_context_changed')
    require(target_identity(context.get('target')) == actual_target, 'prepared_target_changed')
    ticket = document.get('ticket')
    require(type(ticket) is dict and type(ticket.get('payload')) is dict, 'invalid_prepared_ticket')
    payload = ticket['payload']
    proof_fields = {}
    if type(payload.get('version')) is int and payload['version'] == 2:
        plan = {'ticketVersion': 2, 'approvedSourceSha': payload.get('sourceSha'), 'targetSha': payload.get('targetSha'),
                'expectedTreeSha': payload.get('expectedTreeSha'), 'validationProfile': payload.get('validationProfile'),
                'parents': [payload.get('targetSha'), payload.get('sourceSha')], 'proofPending': True}
        require(all(context.get(field) == value and prepared.get(field) == value for field, value in plan.items()), 'prepared_merge_plan_changed')
        require(type(commit_proof) is dict and set(commit_proof) == {'sha', 'parents', 'treeSha', 'verification'}, 'missing_commit_proof')
        verification = commit_proof['verification']
        require(type(verification) is dict and set(verification) == {'source', 'profile', 'passed'}, 'invalid_verification_proof')
        require(type(commit_proof['parents']) is list and len(commit_proof['parents']) == 2
                and type(commit_proof['sha']) is str and commit_proof['sha'] == expected['sourceSha'], 'local_commit_mismatch')
        proof_fields = dict(approved_source_sha=context['approvedSourceSha'], target_sha=context['targetSha'],
                            tree_sha=commit_proof['treeSha'], parents=tuple(commit_proof['parents']),
                            verification_source_sha=verification['source'], verification_profile=verification['profile'],
                            verification_passed=verification['passed'])
    else:
        require(context.get('ticketVersion', 1) == 1 and prepared.get('ticketVersion', 1) == 1, 'prepared_ticket_version_changed')
    key = gate._private_read(str(KEY), gate.MAX_KEY_BYTES)
    gate_context = gate.GateContext(job=expected['job'], build_id=expected['buildId'], source_sha=expected['sourceSha'], project_id=expected['projectId'], destination_id=context['destinationId'], environment='test', key_id=context['keyId'], **proof_fields)
    result = gate.admit(ticket, key, gate_context, str(STATE), clock=(lambda: now) if now else gate._utcnow)
    if proof_fields:
        # Built ONLY from authenticated plan + validated actual local proof after
        # single-use admission. It is verification evidence, not deployment success.
        result['mergeVerification'] = dict(version=2, sourceSha=result['approvedSourceSha'], deployedSha=result['sourceSha'],
            targetSha=result['targetSha'], treeSha=result['treeSha'], parents=result['parents'], profile=result['validationProfile'], passed=True)
    return dict(result, gated=True)


def deploy_mount_args(prepared):
    """Only fixed host assets/key/state + exact prepared file enter deploy worker."""
    require(type(prepared) is dict and prepared.get('mode') in ('manual', 'human', 'nightshift'), 'missing_prepared_identity')
    if prepared['mode'] != 'nightshift':
        return ['--mount', 'type=bind,src=' + str(ASSETS) + ',dst=' + str(ASSETS) + ',readonly']
    path = prepared.get('contextPath')
    require(type(path) is str and Path(path).parent == PREPARED and re.fullmatch(r'[0-9a-f]{64}\.json', Path(path).name), 'unsafe_prepared_path')
    result = []
    for source, readonly in ((str(ASSETS), True), (str(KEY), True), (path, True), (str(STATE), False)):
        result.extend(['--mount', 'type=bind,src=' + source + ',dst=' + source + (',readonly' if readonly else '')])
    return result


def main():
    try:
        parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
        parser.add_argument('action', choices=('prepare',))
        args = parser.parse_args()
        result = prepare(dict(os.environ), trusted_target={key: os.environ.get(name) for key, name in (('namespace', 'DEPLOY_NS'), ('deployment', 'DEPLOY_DEP'), ('container', 'DEPLOY_CONTAINER'))})
        print(json.dumps(result, sort_keys=True, separators=(',', ':')))
        return 0
    except Exception:
        print('{"allowed":false,"reason":"publisher_hook_denied"}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
