#!/usr/bin/env python3
"""Offline exact-version publisher patch preparation, never live installation.

Reads the credential-scanned 2026-11-10 capture, verifies every byte/hash against
its manifest AND the pins below, emits a NEW directory only. Existing controls
(source freshness, frontend patch_admission, cleanup) remain intact. No shell,
GitLab writes, Docker builds, Jenkins triggers or Kubernetes calls are performed.
Review emitted diff/mount tests before Lead deploys. Prepared is not deploy-ready:
trusted GenericCause actor export, fixed private routes/read credentials/key/state,
asset hashes, FS permissions and actual container boundaries need operator setup.
"""
from __future__ import annotations
import argparse
import ast
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys

PINS = {
    'mate-java-release.sh': '37638e7346e5ff9019fbcbfaa76304fbf2fd285b268cbaaba7a7f3a7be931910',
    'mate-java-release.py': 'fd26fe6cf8ed475e13bac264bf6b089d0eeb954a29ecf5866a136ed28e1afec1',
    'mate-web-build-push.sh': '4ab71ff4115f868444754522ee70a598580e0415c5eba17bdd47923cacfc5073',
    'mate-web-deploy.py': '8a6943cb3f516d559521e8d140446f917b3d85c3c83f1e9310f7e995f4e79c71',
}
WEB_CONTROLLER_SHA = '9f7bd285d66f567b6c7b4b1021f0445e5d0d9d26c6ce84e83eec7e628b78cf9b'
ROOT = '/var/lib/jenkins/superagent-nightshift'
ASSETS = ROOT + '/assets'


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def replace_once(text, old, new):
    require(text.count(old) == 1, 'Pinned patch anchor is absent or ambiguous')
    return text.replace(old, new, 1)


def loader(hook_sha):
    return '''\n\ndef nightshift_hook():
    # Only root/operator-installed code; no source-tree or model-selected module.
    import importlib.util
    import sys
    sys.dont_write_bytecode = True  # immutable public asset directories never gain __pycache__
    path = Path("ASSET_ROOT/merge-v2/publisher-hook.py")
    require(not path.is_symlink() and hashlib.sha256(path.read_bytes()).hexdigest() == "HOOK_HASH", 'Nightshift hook pin mismatch')
    spec = importlib.util.spec_from_file_location('_trusted_nightshift_publisher', path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module
'''.replace('ASSET_ROOT', ASSETS).replace('HOOK_HASH', hook_sha)


def merge_helpers():
    return r'''

def nightshift_v2(prepared):
    return prepared.get('mode') == 'nightshift' and type(prepared.get('ticketVersion')) is int and prepared['ticketVersion'] == 2


def nightshift_commit_objects(prepared, directory, actual_sha):
    # Trusted controller only: fixed Git commands, no repository programs/filters,
    # no network or inherited credentials. M must already exist in the cloned repo.
    if not nightshift_v2(prepared):
        return None
    require(re.fullmatch('[0-9a-f]{40}', actual_sha) and actual_sha == prepared['sourceSha'], 'Merged source identity mismatch')
    clean = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '0', 'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0', 'GIT_ALLOW_PROTOCOL': ''}
    prefix = ['/usr/bin/git', '--no-replace-objects', '--no-pager', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'submodule.recurse=false', '-c', 'protocol.allow=never', '-C', str(directory)]
    def git(*args):
        result = subprocess.run(prefix + list(args), env=clean, capture_output=True, timeout=30)
        require(result.returncode == 0 and len(result.stdout) <= 1048576 and len(result.stderr) <= 1048576, 'Immutable merged source inspection failed')
        return result.stdout
    keys = git('config', '--no-includes', '--name-only', '--list').decode().splitlines()
    require(not any(re.match(r'^(?:include\.path|includeif\..+\.path|filter\..+\.(?:clean|smudge|process)|core\.(?:worktree|sshcommand))$', key, re.I) for key in keys), 'Unsafe merged source Git config')
    require(git('rev-parse', 'HEAD').decode().strip() == actual_sha, 'Merged checkout changed')
    # Never trust the mutable index (assume-unchanged/skip-worktree/cache flags).
    # Enumerate the immutable commit tree, then hash actual no-follow file bytes.
    import stat
    root = Path(directory).resolve()
    require(root == Path(directory).absolute() and not Path(directory).is_symlink(), 'Unsafe merged checkout root')
    entries = git('ls-tree', '-r', '-z', '--full-tree', actual_sha).split(b'\0')
    total = 0
    require(len(entries) <= 20001, 'Merged source inventory too large')
    for entry in entries:
        if not entry:
            continue
        header, separator, raw_name = entry.partition(b'\t')
        fields = header.split(b' ')
        require(separator and len(fields) == 3 and fields[0] in (b'100644', b'100755') and fields[1] == b'blob' and re.fullmatch(b'[0-9a-f]{40}', fields[2]), 'Merged source links or submodules unsupported')
        name = raw_name.decode('utf-8')
        parts = name.split('/')
        require(name and not name.startswith('/') and all(part not in ('', '.', '..', '.git') for part in parts), 'Unsafe immutable source path')
        parent = os.open(str(root), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        fd = None
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
                os.close(parent); parent = child
            fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            info = os.fstat(fd)
            require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 16777216, 'Unsafe or oversized tracked merged source')
            require(bool(info.st_mode & 0o111) == (fields[0] == b'100755'), 'Merged source executable mode changed')
            digest = hashlib.sha1(b'blob ' + str(info.st_size).encode() + b'\0')
            count = 0
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                count += len(chunk); total += len(chunk)
                require(count <= info.st_size and total <= 268435456, 'Merged source byte budget exceeded')
                digest.update(chunk)
            after = os.fstat(fd)
            require(count == info.st_size and (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns) == (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns), 'Merged source changed while inspected')
            require(digest.hexdigest().encode() == fields[2], 'Tracked merged source bytes differ from immutable M')
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)
    raw = git('cat-file', 'commit', actual_sha)
    require(hashlib.sha1(b'commit ' + str(len(raw)).encode() + b'\0' + raw).hexdigest() == actual_sha, 'Merged object hash mismatch')
    headers = raw.decode('utf-8').split('\n\n', 1)[0].splitlines()
    trees = [line[5:] for line in headers if line.startswith('tree ')]
    parents = [line[7:] for line in headers if line.startswith('parent ')]
    require(trees == [prepared['expectedTreeSha']] and parents == [prepared['targetSha'], prepared['approvedSourceSha']] == prepared['parents'], 'Merged tree or ordered parents differ from signed plan')
    require(git('cat-file', '-t', trees[0]).strip() == b'tree', 'Merged tree is unavailable')
    return {'sha': actual_sha, 'parents': parents, 'treeSha': trees[0]}


def nightshift_verification(proof, prepared, actual_sha):
    require(nightshift_v2(prepared) and proof == {'sha': actual_sha, 'parents': prepared['parents'], 'treeSha': prepared['expectedTreeSha']} and prepared['validationProfile'] == 'full-verify', 'Unverified merge object proof')
    return dict(proof, verification={'source': actual_sha, 'profile': 'full-verify', 'passed': True})


def nightshift_archive(result, path):
    # Archive only the gate-returned exact evidence, never synthesize from input.
    value = result.get('mergeVerification')
    if value is None:
        return
    require(type(value) is dict and set(value) == {'version', 'sourceSha', 'deployedSha', 'targetSha', 'treeSha', 'parents', 'profile', 'passed'} and value['version'] == 2 and value['profile'] == 'full-verify' and value['passed'] is True, 'Invalid merge verification artifact')
    require(not path.exists() and not path.is_symlink(), 'Preexisting merge verification artifact')
    with path.open('x', encoding='utf-8') as stream:
        json.dump(value, stream, sort_keys=True, separators=(',', ':')); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
'''


def controller_mounts():
    return '''# Nightshift controller bindings. Human/manual jobs require only public trusted assets.
NIGHTSHIFT_ROOT=/var/lib/jenkins/superagent-nightshift
[[ -d "$NIGHTSHIFT_ROOT/assets" && ! -L "$NIGHTSHIFT_ROOT/assets" ]] || { echo 'Nightshift public assets unavailable'; exit 1; }
args+=(--mount "type=bind,src=$NIGHTSHIFT_ROOT/assets,dst=$NIGHTSHIFT_ROOT/assets,readonly")
nightshift_bot=false
case "${RELEASE_TRIGGER_KIND:-}" in
  manual)
    [[ -z "${RELEASE_EVENT_ACTOR:-}" ]] || { echo 'Manual event actor conflict'; exit 1; }
    ;;
  master-push)
    [[ "${RELEASE_EVENT_ACTOR:-}" =~ ^[1-9][0-9]{0,15}$ ]] || { echo 'Missing trusted webhook actor'; exit 1; }
    if (( RELEASE_EVENT_ACTOR >= 95 && RELEASE_EVENT_ACTOR <= 111 )); then nightshift_bot=true; fi
    ;;
  *) echo 'Unknown trusted release cause'; exit 1 ;;
esac
if [[ "$nightshift_bot" == true ]]; then
  # Never bind these into untrusted source/build/image worker command arrays.
  for path in "$NIGHTSHIFT_ROOT/routes.json" "$NIGHTSHIFT_ROOT/signing.key" "$NIGHTSHIFT_ROOT/read-credentials"; do
    [[ "$path" == "$NIGHTSHIFT_ROOT/"* && -e "$path" && ! -L "$path" ]] || { echo 'Nightshift private controller bindings unavailable'; exit 1; }
    args+=(--mount "type=bind,src=$path,dst=$path,readonly")
  done
  for path in "$NIGHTSHIFT_ROOT/prepared" "$NIGHTSHIFT_ROOT/replay"; do
    [[ -d "$path" && ! -L "$path" ]] || { echo 'Nightshift private state unavailable'; exit 1; }
    args+=(--mount "type=bind,src=$path,dst=$path")
  done
fi
'''


def patch_java_shell(text):
    text = replace_once(text, 'for name in RELEASE_TRIGGER_KIND RELEASE_EVENT_SHA RELEASE_EVENT_PROJECT RELEASE_EVENT_REF RELEASE_EVENT_PATH RELEASE_EVENT_SOURCE; do', 'for name in RELEASE_TRIGGER_KIND RELEASE_EVENT_SHA RELEASE_EVENT_PROJECT RELEASE_EVENT_REF RELEASE_EVENT_PATH RELEASE_EVENT_SOURCE RELEASE_EVENT_ACTOR; do')
    return replace_once(text, "CONTROL_TOOL='", controller_mounts() + "CONTROL_TOOL='")


def java_merge_helpers():
    return r'''

def nightshift_java_full_verification(prepared, cfg, work, proof, actual_sha):
    # Full-verify succeeded and source_identity ran in the verify worker. Re-audit
    # actual JUnit reports in trusted controller, never trust a source JSON echo.
    require(build_policy(cfg) == 'full-verify', 'Bot merge requires full verification')
    require(nightshift_commit_objects(prepared, work, actual_sha) == proof, 'Verified merged source changed')
    original = Path.cwd()
    try:
        os.chdir(work)
        validate_build_evidence(cfg)
        result = read_json('test-audit.json')
    finally:
        os.chdir(original)
    require(set(result) == {'tests', 'skipped', 'failures', 'errors', 'core_executed', 'reason'} and all(type(result[key]) is int and result[key] >= 0 for key in ('tests', 'skipped', 'failures', 'errors', 'core_executed')) and result['tests'] > 0 and result['failures'] == result['errors'] == 0 and result['reason'] is None and 0 < result['core_executed'] <= result['tests'] - result['skipped'], 'Merged-source JUnit evidence failed')
    return nightshift_verification(proof, prepared, actual_sha)
'''


def patch_java_runtime(text, hook_sha):
    text = replace_once(text, 'REDACTIONS = set()\n', 'REDACTIONS = set()\n' + loader(hook_sha) + merge_helpers() + java_merge_helpers())
    text = replace_once(text, "    cfg['SCRIPT_SHA256'] = sha(Path(__file__).read_bytes())", "    # Trusted cause is checked before source/build stages; only public prepared context enters cfg.\n    cfg['NIGHTSHIFT_PREPARED'] = json.dumps(nightshift_hook().prepare(dict(os.environ), trusted_target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])), sort_keys=True, separators=(',', ':'))\n    if nightshift_v2(json.loads(cfg['NIGHTSHIFT_PREPARED'])):\n        cfg['AUTO_BUILD_PROFILE'] = 'full-verify'\n    cfg['SCRIPT_SHA256'] = sha(Path(__file__).read_bytes())")
    text = replace_once(text, "        mount(paths['kube'], paths['kube'], True)", "        command.extend(nightshift_hook().deploy_mount_args(json.loads(cfg['NIGHTSHIFT_PREPARED'])))\n        mount(paths['kube'], paths['kube'], True)")
    text = replace_once(text, "        attempted_patch = True\n        kube('patch'", "        # Preserve the existing fresh source_identity check above. Consume once at WRITE boundary.\n        nightshift_hook().admit_prepared(json.loads(cfg['NIGHTSHIFT_PREPARED']), dict(job=identity['jenkins_job'], buildId=identity['jenkins_build'], sourceSha=identity['source'], projectId=int(identity['project']) if identity['mode'] != 'manual' else 0, environment='test', target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])))\n        attempted_patch = True\n        kube('patch'")
    text = replace_once(text, "            (work / '.private').mkdir(mode=0o700)", "            prepared = json.loads(cfg['NIGHTSHIFT_PREPARED'])\n            merge_objects = nightshift_commit_objects(prepared, work, identity['source'])\n            merge_proof_path = run_dir / 'nightshift-commit-proof.json'\n            (work / '.private').mkdir(mode=0o700)")
    text = replace_once(text, "            for stage in ('verify', 'image', 'deploy'):", "            for stage in ('verify', 'image', 'deploy'):\n                if nightshift_v2(prepared) and stage in ('image', 'deploy'):\n                    require(merge_proof_path.is_file(), 'Merged-source verification has not passed')\n                    require(nightshift_commit_objects(prepared, work, identity['source']) == merge_objects, 'Merged source changed after tests')")
    text = replace_once(text, "                    if code:\n                        raise subprocess.CalledProcessError(code, ['stage', stage])", "                    if code:\n                        raise subprocess.CalledProcessError(code, ['stage', stage])\n                    if stage == 'verify' and nightshift_v2(prepared):\n                        require(not merge_proof_path.exists() and not merge_proof_path.is_symlink(), 'Merge proof already exists')\n                        commit_proof = nightshift_java_full_verification(prepared, cfg, work, merge_objects, identity['source'])\n                        atomic_json(merge_proof_path, commit_proof)\n                        paths['nightshift_proof'] = merge_proof_path")
    text = replace_once(text, "    if stage == 'verify':\n        mount(paths['settings'], paths['settings'], True)", "    if stage == 'verify':\n        if nightshift_v2(json.loads(cfg['NIGHTSHIFT_PREPARED'])):\n            mount(paths['work'] / '.git', paths['work'] / '.git', True)\n        mount(paths['settings'], paths['settings'], True)")
    text = replace_once(text, "        mount(paths['kube'], paths['kube'], True)", "        if nightshift_v2(json.loads(cfg['NIGHTSHIFT_PREPARED'])):\n            mount(paths['nightshift_proof'], '/tmp/nightshift-commit-proof.json', True)\n        mount(paths['kube'], paths['kube'], True)")
    old_call = "        nightshift_hook().admit_prepared(json.loads(cfg['NIGHTSHIFT_PREPARED']), dict(job=identity['jenkins_job'], buildId=identity['jenkins_build'], sourceSha=identity['source'], projectId=int(identity['project']) if identity['mode'] != 'manual' else 0, environment='test', target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])))"
    new_call = "        prepared = json.loads(cfg['NIGHTSHIFT_PREPARED'])\n        proof = read_json('/tmp/nightshift-commit-proof.json') if nightshift_v2(prepared) else None\n        admission = nightshift_hook().admit_prepared(prepared, dict(job=identity['jenkins_job'], buildId=identity['jenkins_build'], sourceSha=identity['source'], projectId=int(identity['project']) if identity['mode'] != 'manual' else 0, environment='test', target=dict(namespace=cfg['DEPLOY_NAMESPACE'], deployment=cfg['DEPLOYMENT'], container=cfg['APP_CONTAINER'])), commit_proof=proof)\n        nightshift_archive(admission, Path('nightshift-merge-verification.json'))"
    text = replace_once(text, old_call, new_call)
    text = replace_once(text, "for name in ('test-audit.json', 'build-audit.json', 'image-diagnostic.json', 'release-manifest.json', 'release.json', 'deploy-diagnostic.json'):", "for name in ('nightshift-merge-verification.json', 'test-audit.json', 'build-audit.json', 'image-diagnostic.json', 'release-manifest.json', 'release.json', 'deploy-diagnostic.json'):")
    return text


def patch_web_controller(text, hook_sha):
    text = replace_once(text, '\ndef require(ok, reason):', loader(hook_sha) + merge_helpers() + '\ndef require(ok, reason):')
    text = replace_once(text, "    policy = build_policy(meta, env)", "    policy = build_policy(meta, env)\n    prepared = nightshift_hook().prepare(env, trusted_target=dict(namespace='mate-frontend', deployment=meta['service'], container=cfg['services'][meta['service']]['container']))\n    if nightshift_v2(prepared):\n        policy = dict(policy, profile='full-verify')\n    # Non-secret immutable identity only; build/image config never receives credentials.\n    cfg = dict(cfg, NIGHTSHIFT_PREPARED=prepared)")
    text = replace_once(text, "    if stage == 'verify':\n        args += ['--mount'", "    if stage == 'deploy':\n        args += nightshift_hook().deploy_mount_args(cfg['NIGHTSHIFT_PREPARED'])\n    if stage == 'verify':\n        args += ['--mount'")
    text = replace_once(text, "        request.write_text(json.dumps(dict(patch_nonce=admission['patch_nonce'],", "        request.write_text(json.dumps(dict(nightshift_prepared=prepared, nightshift_context=dict(job=env['JOB_NAME'], buildId=env['BUILD_NUMBER'], sourceSha=meta['source'], projectId=int(env.get('RELEASE_EVENT_PROJECT', '0') or '0'), environment='test'), patch_nonce=admission['patch_nonce'],")
    text = replace_once(text, "        verify_cfg = root / 'public-build.json'", "        merge_objects = nightshift_commit_objects(prepared, source, meta['source'])\n        verify_cfg = root / 'public-build.json'")
    text = replace_once(text, "        validate_build_report(audit, meta, public_build)", "        validate_build_report(audit, meta, public_build)\n        commit_proof = None\n        if nightshift_v2(prepared):\n            require(nightshift_commit_objects(prepared, source, meta['source']) == merge_objects, 'Merged source changed during full verification')\n            require(audit.get('profile') == 'full-verify' and audit.get('tests_executed') is True, 'Merged source full verification missing')\n            commit_proof = nightshift_verification(merge_objects, prepared, meta['source'])")
    text = replace_once(text, "        admission['patch_nonce'] = uuid.uuid4().hex", "        admission['patch_nonce'] = uuid.uuid4().hex\n        if commit_proof is not None:\n            admission['commit_proof'] = commit_proof")
    text = replace_once(text, "request.write_text(json.dumps(dict(nightshift_prepared=prepared,", "request.write_text(json.dumps(dict(commit_proof=commit_proof, nightshift_prepared=prepared,")
    text = replace_once(text, "        # Use the exact mounted deployment file as the worker code.", "        if nightshift_v2(prepared):\n            require(nightshift_commit_objects(prepared, source, meta['source']) == merge_objects, 'Merged source changed before deploy')\n        # Use the exact mounted deployment file as the worker code.")
    text = replace_once(text, "for name in ('frontend-verify.json', 'frontend-build.json', 'release.json'):", "for name in ('nightshift-merge-verification.json', 'frontend-verify.json', 'frontend-build.json', 'release.json'):")
    return text


def patch_web_shell(text, hook_sha):
    pattern = r'(base64 -d > "\$ASSETS/mate-web-release\.py" <<\'PUBLIC_ASSET\'\n)([^\n]+)(\nPUBLIC_ASSET\necho \'([0-9a-f]{64})  \')'
    matches = list(re.finditer(pattern, text))
    require(len(matches) == 1, 'Public controller embedding not recognized')
    match = matches[0]
    raw = base64.b64decode(match.group(2), validate=True)
    require(hashlib.sha256(raw).hexdigest() == match.group(4) == WEB_CONTROLLER_SHA, 'Embedded controller hash mismatch')
    controller = patch_web_controller(raw.decode('utf-8'), hook_sha)
    ast.parse(controller)
    encoded = base64.b64encode(controller.encode()).decode()
    replacement = match.group(1) + encoded + match.group(3).replace(WEB_CONTROLLER_SHA, hashlib.sha256(controller.encode()).hexdigest())
    text = text[:match.start()] + replacement + text[match.end():]
    text = replace_once(text, ' RELEASE_EVENT_SOURCE AUTO_BUILD_PROFILE MANUAL_BUILD_PROFILE; do', ' RELEASE_EVENT_SOURCE RELEASE_EVENT_ACTOR AUTO_BUILD_PROFILE MANUAL_BUILD_PROFILE; do')
    text = replace_once(text, '"${args[@]}" sha256:', controller_mounts() + '"${args[@]}" sha256:')
    text = replace_once(text, 'for name in frontend-build.json frontend-verify.json release.json; do', 'for name in nightshift-merge-verification.json frontend-build.json frontend-verify.json release.json; do')
    return text, controller


def patch_web_deploy(text, hook_sha):
    text = replace_once(text, '\nTARGETS = {', loader(hook_sha) + merge_helpers() + '\nTARGETS = {')
    text = replace_once(text, "        patch_admission(request)\n        receipt.update(result='unknown'", "        patch_admission(request)\n        # Existing controller source-admission IPC remains first; do not bypass its fresh ref check.\n        nightshift_hook().admit_prepared(request['nightshift_prepared'], dict(request['nightshift_context'], target=dict(namespace=before['metadata']['namespace'], deployment=before['metadata']['name'], container=contract['container'])))\n        receipt.update(result='unknown'")
    text = replace_once(text, "    identity = {k: request[k] for k in ('service', 'source', 'attempt', 'patch_nonce')}", "    identity = {k: request[k] for k in ('service', 'source', 'attempt', 'patch_nonce')}\n    if nightshift_v2(request.get('nightshift_prepared', {})):\n        require(type(request.get('commit_proof')) is dict, 'Missing trusted merge proof')\n        identity['commit_proof'] = request['commit_proof']")
    old_call = "        nightshift_hook().admit_prepared(request['nightshift_prepared'], dict(request['nightshift_context'], target=dict(namespace=before['metadata']['namespace'], deployment=before['metadata']['name'], container=contract['container'])))"
    new_call = "        admission = nightshift_hook().admit_prepared(request['nightshift_prepared'], dict(request['nightshift_context'], target=dict(namespace=before['metadata']['namespace'], deployment=before['metadata']['name'], container=contract['container'])), commit_proof=request.get('commit_proof'))\n        nightshift_archive(admission, Path('nightshift-merge-verification.json'))"
    text = replace_once(text, old_call, new_call)
    return text


def generate(source, destination):
    source, destination = Path(source), Path(destination)
    require(source.is_absolute() and source.resolve() == source and source.is_dir(), 'Input directory must be canonical')
    require(destination.is_absolute() and destination.parent.resolve() == destination.parent and not destination.exists() and not destination.is_symlink(), 'Output must be a NEW canonical directory')
    require(not destination.is_relative_to(source), 'Output may not overlap captured sources')
    manifest_path = source / 'manifest.json'
    require(manifest_path.is_file() and not manifest_path.is_symlink(), 'Input manifest missing')
    manifest = json.loads(manifest_path.read_text())
    require(type(manifest) is list and len(manifest) == len(PINS) and {item['file'] for item in manifest} == set(PINS), 'Input manifest inventory mismatch')
    sources = {}
    for item in manifest:
        name = item['file']; path = source / name
        require(path.is_file() and not path.is_symlink(), 'Input source path unsafe')
        raw = path.read_bytes()
        require(item.get('sha256') == PINS[name] == hashlib.sha256(raw).hexdigest() and item.get('bytes') == len(raw), 'Captured source hash/size mismatch')
        sources[name] = raw.decode('utf-8')
    assets_dir = Path(__file__).resolve().parent
    hook = (assets_dir / 'publisher-hook.py').read_bytes(); gate = (assets_dir / 'nightshift-gate.py').read_bytes()
    hook_sha = hashlib.sha256(hook).hexdigest()
    require(hashlib.sha256(gate).hexdigest() == '319878487367c209dbc80532fe46354dd05e1bcc1bbb5243409513e96fc01388', 'Signed gate changed; review pins before preparing')
    outputs = {'mate-java-release.sh': patch_java_shell(sources['mate-java-release.sh']), 'mate-java-release.py': patch_java_runtime(sources['mate-java-release.py'], hook_sha), 'mate-web-deploy.py': patch_web_deploy(sources['mate-web-deploy.py'], hook_sha)}
    outputs['mate-web-build-push.sh'], controller = patch_web_shell(sources['mate-web-build-push.sh'], hook_sha)
    for name, value in outputs.items():
        if name.endswith('.py'):
            ast.parse(value)
    destination.mkdir(mode=0o700)
    output_manifest = []
    for name, value in {**outputs, 'decoded-mate-web-release.py': controller, 'publisher-hook.py': hook.decode(), 'nightshift-gate.py': gate.decode()}.items():
        path = destination / name
        with path.open('x', encoding='utf-8') as stream:
            stream.write(value); stream.flush(); os.fsync(stream.fileno())
        path.chmod(0o600)
        output_manifest.append({'file': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size})
    report = {'version': 1, 'preparedOnly': True, 'deployReady': False, 'inputManifestSha256': hashlib.sha256(manifest_path.read_bytes()).hexdigest(), 'inputPins': PINS, 'outputs': output_manifest, 'prerequisites': ['Admin EnvInject trusted actor from authenticated GenericCause; never build parameter', 'Install exact pinned hook/gate under fixed assets directory outside all source roots', 'Private exact per-project Reporter read_api credentials; controller-only mount', 'HMAC key controller/deploy-only; no source/build/image mounts or environment', 'Private prepared/replay directories shared only by trusted controller/deploy', 'Review docker-socket authority and existing source-image boundaries; not an OS sandbox', 'Test mounted path ancestor modes with gate private file traversal', 'No new pipeline, job trigger or rollback; existing merge webhook remains sole trigger']}
    with (destination / 'patch-manifest.json').open('x') as stream:
        json.dump(report, stream, sort_keys=True, indent=2); stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    return report


def main():
    try:
        parser = argparse.ArgumentParser(allow_abbrev=False)
        parser.add_argument('--source', required=True)
        parser.add_argument('--output', required=True)
        args = parser.parse_args()
        report = generate(args.source, args.output)
        print(json.dumps({'prepared': True, 'deployReady': False, 'files': len(report['outputs'])}, separators=(',', ':')))
        return 0
    except Exception:
        print('{"prepared":false,"reason":"publisher_patch_denied"}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
