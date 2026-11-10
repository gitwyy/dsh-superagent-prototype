#!/usr/bin/python3
"""Operator-pinned LOCAL SOURCE GATE, not tests, compilation, or an OS sandbox.

Run with no arguments from the exact approved repository root. Reads only local
Git metadata and changed tracked/untracked ordinary source; never runs repo code,
tests, build scripts, Git hooks/filters, network commands, or credential helpers.
Passing this gate does NOT imply unit tests pass or that Java/JS/TS compiles.
A successful exact-source-SHA GitLab MR validation pipeline is still required.
The host action broker owns repository authorization and executable/CI pins.
"""
import ast
import json
import os
from pathlib import Path
import re
import selectors
import stat
import subprocess
import sys
import time
import xml.etree.ElementTree as ET

MAX_OUTPUT = 8 * 1024 * 1024
MAX_FILE = 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_FILES = 200
GIT = '/usr/bin/git'
SAFE = ['--no-replace-objects', '--literal-pathspecs', '--no-pager',
        '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        '-c', 'core.untrackedCache=false', '-c', 'core.attributesFile=/dev/null',
        '-c', 'core.pager=cat', '-c', 'diff.external=', '-c', 'diff.submodule=short',
        '-c', 'log.showSignature=false', '-c', 'status.submoduleSummary=false',
        '-c', 'submodule.recurse=false', '-c', 'credential.helper=',
        '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=never',
        '-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
ENV = {'PATH': '/usr/bin:/bin', 'HOME': '/nonexistent', 'LANG': 'C', 'LC_ALL': 'C',
       'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null',
       'GIT_CONFIG_COUNT': '0', 'GIT_TERMINAL_PROMPT': '0', 'GIT_OPTIONAL_LOCKS': '0',
       'GIT_NO_REPLACE_OBJECTS': '1', 'GIT_ALLOW_PROTOCOL': ''}


class GateFailure(Exception):
    """Fixed nonsecret reason only; paths/content/child diagnostics are suppressed."""


def require(ok, reason):
    if not ok:
        raise GateFailure(reason)


def git(root, args, limit=MAX_OUTPUT):
    """Bound output while streaming; no shell and no external command retry."""
    process = subprocess.Popen([GIT] + SAFE + ['-C', str(root)] + args, env=ENV,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, shell=False)
    selector = selectors.DefaultSelector()
    output = bytearray()
    count = 0
    deadline = time.monotonic() + 10
    try:
        selector.register(process.stdout, selectors.EVENT_READ, True)
        selector.register(process.stderr, selectors.EVENT_READ, False)
        while selector.get_map():
            require(time.monotonic() < deadline, 'git_timeout')
            for key, _ in selector.select(min(.1, max(0, deadline - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                count += len(data)
                require(count <= limit, 'git_output_limit')
                if key.data:
                    output.extend(data)
        require(process.wait(timeout=max(.01, deadline - time.monotonic())) == 0, 'git_check_failed')
        return bytes(output)
    except (OSError, subprocess.TimeoutExpired):
        raise GateFailure('git_check_failed') from None
    finally:
        selector.close()
        if process.poll() is None:
            try:
                process.kill()
            except OSError:
                pass
        process.wait()
        process.stdout.close()
        process.stderr.close()


def nul_names(raw):
    require(not raw or raw.endswith(b'\0'), 'invalid_git_records')
    try:
        return [name.decode('utf-8', errors='strict') for name in raw.split(b'\0') if name]
    except UnicodeError:
        raise GateFailure('unsupported_path_encoding') from None


def protected(name):
    parts = name.replace('\\', '/').split('/')
    for part in parts:
        low = part.lower()
        if (low in ('.git', '.pi', '.agents', '.github', '.gitlab', '.mvn', '.ssh', '.aws',
                    'scripts', 'ci', 'deploy', 'deployment', 'release', 'infra', 'infrastructure',
                    'helm', 'charts', 'terraform', 'node_modules', '.gitmodules', '.gitattributes',
                    '.npmrc', '.yarnrc', '.yarnrc.yml')
                or low.startswith(('.gitlab-ci', 'jenkinsfile', 'dockerfile', 'docker-compose', '.env'))
                or re.search(r'(^|[._-])(credential|credentials|secret|secrets|token|tokens)([._-]|$)', low)
                or low.endswith(('.pem', '.key', '.p12', '.pfx'))):
            return True
    return False


def safe_path(root, name, missing=False):
    require(type(name) is str and name and '\0' not in name and not name.startswith('/')
            and len(name) <= 4096 and all(part not in ('', '.', '..') for part in name.split('/')), 'unsafe_source_path')
    require(not protected(name), 'protected_control_or_secret_path')
    cursor = root
    for part in name.split('/'):
        cursor = cursor / part
        try:
            info = cursor.lstat()
        except FileNotFoundError:
            require(missing, 'missing_source')
            continue
        require(not stat.S_ISLNK(info.st_mode) and (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)), 'source_link_or_special_file')
        if stat.S_ISDIR(info.st_mode):
            require(not (cursor / '.git').exists(), 'nested_repository_not_in_scope')
        else:
            require(info.st_nlink == 1, 'source_hardlink')
    return cursor


def read_source(path):
    fd = os.open(str(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= MAX_FILE, 'source_file_limit_or_type')
        chunks = []
        size = 0
        while True:
            chunk = os.read(fd, min(65536, MAX_FILE + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            require(size <= MAX_FILE, 'source_file_limit_or_type')
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'source_changed_during_check')
        return b''.join(chunks)
    finally:
        os.close(fd)


def syntax(name, raw):
    require(b'\0' not in raw, 'binary_source_unsupported')
    try:
        text = raw.decode('utf-8-sig')
    except UnicodeError:
        raise GateFailure('source_encoding_unsupported') from None
    require(not re.search(r'(?m)^(?:<<<<<<<(?:\s|$)|=======$|>>>>>>>(?:\s|$)|\|{7}(?:\s|$))', text), 'merge_conflict_marker')
    suffix = Path(name).suffix.lower()
    try:
        if suffix == '.json':
            def pairs(items):
                result = {}
                for key, value in items:
                    require(key not in result, 'duplicate_json_key')
                    result[key] = value
                return result
            json.loads(text, object_pairs_hook=pairs,
                       parse_constant=lambda _: (_ for _ in ()).throw(GateFailure('invalid_json_constant')))
        elif suffix in ('.xml', '.xsd', '.xsl', '.xslt', '.svg'):
            require(not re.search(r'<!\s*(?:DOCTYPE|ENTITY)', text, re.I), 'xml_dtd_or_entity_unsupported')
            ET.fromstring(text)
        elif suffix == '.py':
            ast.parse(text, filename='<changed-source>', mode='exec')
    except (ValueError, SyntaxError, ET.ParseError, RecursionError, MemoryError):
        raise GateFailure('changed_source_syntax') from None


def check():
    require(len(sys.argv) == 1, 'arguments_not_supported')
    root = Path(os.getcwd())
    require(root.is_absolute() and root.resolve() == root, 'noncanonical_repository_cwd')
    git_dir = root / '.git'
    require(git_dir.is_dir() and not git_dir.is_symlink() and git_dir.resolve() == git_dir, 'linked_repository_unsupported')
    # Read no-includes config KEYS first; never traverse potentially executable
    # include/conditional include/filter definitions before rejecting their names.
    keys = nul_names(git(root, ['config', '--no-includes', '--name-only', '--null', '--list']))
    require(not any(re.match(r'^(?:include(?:if\..+)?\.path|filter\..+\.(?:clean|smudge|process)|core\.(?:worktree|sshcommand)|extensions\.objectformat)$', key, re.I) for key in keys), 'unsafe_git_configuration')
    for name in ('info/grafts', 'objects/info/alternates', 'objects/info/http-alternates', 'shallow'):
        require(not (git_dir / name).exists() and not (git_dir / name).is_symlink(), 'git_history_redirect_unsupported')
    for name in ('refs/replace', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'):
        require(not (git_dir / name).exists() and not (git_dir / name).is_symlink(), 'git_history_or_operation_unsupported')
    top = git(root, ['rev-parse', '--show-toplevel']).decode('utf-8').strip()
    require(top == str(root) and git(root, ['rev-parse', '--is-bare-repository']).strip() == b'false', 'cwd_is_not_repository_root')
    git(root, ['rev-parse', '--verify', 'HEAD'])
    require(not git(root, ['for-each-ref', '--format=%(refname)', 'refs/replace']).strip(), 'git_history_redirect_unsupported')
    entries = nul_names(git(root, ['ls-files', '--stage', '-z']))
    index = {}
    for entry in entries:
        match = re.fullmatch(r'(\d+) ([0-9a-f]{40}) (\d)\t([\s\S]+)', entry)
        require(match is not None and match[3] == '0', 'unresolved_index')
        index[match[4]] = (match[1], match[2])
    common = ['--no-ext-diff', '--no-textconv', '--ignore-submodules=all', '--no-renames']
    work = nul_names(git(root, ['diff', '--name-only', '-z'] + common + ['HEAD', '--']))
    staged = nul_names(git(root, ['diff', '--cached', '--name-only', '-z'] + common + ['HEAD', '--']))
    untracked = nul_names(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    changed = sorted(set(work + staged + untracked))
    require(len(changed) <= MAX_FILES and sum(len(name) for name in changed) <= 65536, 'changed_file_count_limit')
    for name in changed:
        require(name not in index or index[name][0] in ('100644', '100755'), 'source_symlink_or_gitlink')
        safe_path(root, name, missing=True)
    # Neither raw diagnostics nor changed filenames cross stdout/stderr.
    git(root, ['diff', '--check'] + common + ['HEAD', '--'])
    git(root, ['diff', '--cached', '--check'] + common + ['HEAD', '--'])
    total = 0
    parsed = 0
    for name in changed:
        path = safe_path(root, name, missing=True)
        if path.exists():
            raw = read_source(path)
            total += len(raw)
            require(total <= MAX_TOTAL, 'changed_source_bytes_limit')
            syntax(name, raw)
            parsed += 1
        if name in staged and name in index:
            raw = git(root, ['cat-file', 'blob', index[name][1]], MAX_FILE)
            total += len(raw)
            require(total <= MAX_TOTAL, 'changed_source_bytes_limit')
            syntax(name, raw)
    return dict(source_gate='passed', tests_executed=False, compilation_executed=False,
                changed_files=len(changed), checked_worktree_files=parsed,
                syntax_formats=['json', 'xml-without-dtd', 'python-ast'],
                full_validation='required_same_sha_gitlab_mr_pipeline')


def main():
    try:
        print(json.dumps(check(), sort_keys=True, separators=(',', ':')))
        return 0
    except GateFailure as error:
        print(json.dumps(dict(source_gate='failed', tests_executed=False, compilation_executed=False, reason=str(error)), sort_keys=True, separators=(',', ':')))
        return 1
    except Exception:
        print('{"source_gate":"failed","tests_executed":false,"compilation_executed":false,"reason":"inspection_failed"}')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
