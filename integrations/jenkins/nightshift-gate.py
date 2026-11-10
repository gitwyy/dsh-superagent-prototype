#!/usr/bin/env python3
"""Offline, stdlib-only single-use Jenkins deployment WRITE-ADMISSION gate.

Host integration contract (this module neither configures nor contacts Jenkins):
  * A trusted launcher invokes this gate immediately before the existing deploy
    write (e.g. kubectl patch), not at queue/build start. It must require exit 0
    AND allowed=true, and must never replay/cache that success for another write.
    Only authenticated automation-owned builds are opted into the gate; it does
    not replace the existing merge webhook or trigger another build.
  * Envelope: {"payload": {...}, "signature": "<lowercase hex HMAC-SHA256>"}.
    Sign canonical(payload): UTF-8 JSON, sorted keys, separators=(',', ':'),
    ensure_ascii=True, no floats. All string fields are bounded ASCII. Timestamps
    are explicit RFC3339 offsets (or Z). HMAC has no prefix for publisher interop.
    Required v1 payload fields are PAYLOAD_FIELDS below. V2 adds exactly targetSha,
    expectedTreeSha, validationProfile='full-verify'; signed sourceSha is approved
    candidate S, while GateContext.source_sha is actual deployed merge M. Ordered
    commit parents must be [target T, candidate S], tree must equal signed E, and
    trusted full verification must pass on M. No source/merge SHA equality guess.
    validate_preparation only checks signature/window/route/parents and returns
    proofPending=true, NOT valid/allowed; no API tree or successful tests invented.
    Full validate/admit require trusted local object + verification evidence.
    CLI has no caller-controlled proof flags; v2 CLI calls lacking proof deny.
    Optional signed buildId restricts a known build. Otherwise the FIRST invocation binds job+build ID.
    jobs MUST contain one exact Jenkins full job name. Issue one ticket per job,
    immutable source SHA and operation; nonce must have at least 128 random bits.
  * The raw binary HMAC key (32..4096 bytes) is read only from --key-file, never
    from environment, arguments, repository content, or logs. Provision key ID,
    key path, ticket path, destination/environment/project/job/source/build and
    ONE stable state directory in a trusted launcher, NOT model/build parameters.
    The gate cannot authenticate caller-provided context or discover the actual
    deployed artifact. Publisher/launcher must pin them to verified job evidence.
    Publisher must cap expiresAt to the grant AND active shift deadline; the 12h
    module maximum is only an upper bound. Offline validation cannot discover a
    revocation/paused shift after signing; short expiry or a separate trusted
    revocation channel is needed. No live authorization/credential lookup occurs.
  * Use canonical absolute paths, private 0600/0400 files and a precreated 0700
    state directory on a local durable filesystem. Symlinks (including ancestors),
    hardlinked files, unsafe owners/modes and oversized files are rejected. Root
    sticky temporary ancestors are supported; the leaf state directory is private.
    Key/state access must be isolated from repository/build code. This is NOT an
    OS sandbox against same-user/root tampering or key holders who can forge grants.
  * Two immutable, fsynced O_EXCL intent markers consume (keyId, nonce) and
    (operationId, job). Thus reissued nonces cannot rerun the same operation/job.
    Both same-build and different-build retries are denied, even if the previous
    process crashed or the write never happened. No stale-marker stealing, reset,
    cleanup, retry, rollback, or automatic reconciliation exists here. Keep markers
    across restarts/key rotation. Receipt HMAC binds ticket digest and full context;
    a marker is evidence of consumed intent, NOT successful deployment evidence.
  * validate(ticket, key, GateContext(...), aware_datetime) is a pure check, NOT
    admission. admit(...) additionally consumes durable intent and rechecks time.
    Only CLI/admit success is a one-time admission, never a reusable capability.

EXACT GUARANTEE: no admission whose final trusted-clock sample is at/after expiry
or inside a freeze window; boundaries are [from, until). The retained 2026-11-12
00:00 through 2026-11-14 00:00 +08 freeze is mandatory even if omitted by a signer.
The final sample is AFTER durable intent fsync. Crossing expiry/freeze while
claiming burns the intent and denies. A previously queued build must check here.
This gate CANNOT cancel/stop a patch after admission, cannot atomically couple a
clock sample to an external write, and does NOT guarantee that an admitted write
starts or finishes before expiry/freeze. It provides no post-admission cancellation
or rollback. Do not attest a stronger remoteDeadlineEnforced guarantee from this
module alone. A stale successful response must never be reused after a queue/wait.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
import re
import stat
import sys
from typing import Any, Callable


MAX_TICKET_BYTES = 65536
MAX_KEY_BYTES = 4096
MAX_GRANT_SECONDS = 12 * 60 * 60
MAX_PROJECT_ID = (1 << 53) - 1
RETAINED_FREEZE = {
    "from": "2026-11-12T00:00:00+08:00",
    "until": "2026-11-14T00:00:00+08:00",
}
PAYLOAD_FIELDS = frozenset({
    "version", "taskId", "grantId", "operationId", "projectId", "sourceSha",
    "environment", "jobs", "destinationId", "issuedAt", "notBefore", "expiresAt",
    "freezeWindows", "keyId", "nonce",
})
V2_PAYLOAD_FIELDS = PAYLOAD_FIELDS | {"targetSha", "expectedTreeSha", "validationProfile"}
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\Z", re.ASCII)
_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z", re.ASCII)
_NONCE = re.compile(r"[A-Za-z0-9_-]{32,128}\Z", re.ASCII)
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\Z", re.ASCII)
_JOB = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/ -]{0,255}\Z", re.ASCII)


class GateDenied(Exception):
    """Only fixed reason codes may cross the CLI boundary; never raw exceptions."""


@dataclass(frozen=True)
class GateContext:
    job: str
    build_id: str
    source_sha: str
    project_id: int
    destination_id: str
    environment: str
    key_id: str
    # Optional only for v1 compatibility; v2 requires every field at admission.
    approved_source_sha: str | None = None
    target_sha: str | None = None
    tree_sha: str | None = None
    parents: tuple[str, ...] | None = None
    verification_source_sha: str | None = None
    verification_profile: str | None = None
    verification_passed: bool | None = None


def canonical(value: Any) -> bytes:
    """Publisher-compatible canonical JSON for the restricted ticket schema."""
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"),
                          ensure_ascii=True, allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError):
        raise GateDenied("malformed_ticket") from None


def _text(value: Any, pattern: re.Pattern[str]) -> bool:
    return type(value) is str and pattern.fullmatch(value) is not None


def _job(value: Any) -> bool:
    return (_text(value, _JOB) and value == value.strip()
            and all(part and part not in (".", "..") and part == part.strip()
                    for part in value.split("/")))


def _project(value: Any) -> bool:
    return type(value) is int and 0 < value <= MAX_PROJECT_ID


def _time(value: Any) -> datetime:
    if not _text(value, _TIME):
        raise GateDenied("malformed_time")
    try:
        if not value.endswith("Z"):
            hours, minutes = int(value[-5:-3]), int(value[-2:])
            if hours > 14 or minutes > 59 or (hours == 14 and minutes != 0):
                raise ValueError()
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        offset = parsed.utcoffset()
        if offset is None or abs(offset) > timedelta(hours=14):
            raise ValueError()
        # An RFC3339 unknown local offset is not an asserted UTC timestamp.
        if value.endswith("-00:00"):
            raise ValueError()
        return parsed.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        raise GateDenied("malformed_time") from None


def _clock(value: Any) -> datetime:
    try:
        if not isinstance(value, datetime) or value.utcoffset() is None:
            raise ValueError()
        return value.astimezone(timezone.utc)
    except (ValueError, OverflowError, TypeError):
        raise GateDenied("invalid_clock") from None


def _stamp(value: datetime) -> str:
    return value.isoformat(timespec="microseconds").replace("+00:00", "Z")


def _window(value: Any) -> tuple[datetime, datetime]:
    if type(value) is not dict or set(value) != {"from", "until"}:
        raise GateDenied("malformed_freeze")
    start, end = _time(value["from"]), _time(value["until"])
    if start >= end:
        raise GateDenied("malformed_freeze")
    return start, end


def validate(ticket: dict[str, Any], key: bytes, context: GateContext,
             now: datetime) -> dict[str, Any]:
    """Fully validate ticket AND trusted local proof, without consuming intent."""
    return _validate(ticket, key, context, now, preparation=False)


def validate_preparation(ticket: dict[str, Any], key: bytes, context: GateContext,
                         now: datetime) -> dict[str, Any]:
    """Check controller signature/time/parents only; never a successful proof/admission."""
    result = _validate(ticket, key, context, now, preparation=True)
    result.pop("valid", None)
    return dict(result, prepared=True, proofPending=ticket["payload"]["version"] == 2)


def _object_sha(value: Any) -> bool:
    return _text(value, _SHA) and value != "0" * len(value)


def _validate(ticket: dict[str, Any], key: bytes, context: GateContext,
              now: datetime, *, preparation: bool) -> dict[str, Any]:
    if type(key) is not bytes or not 32 <= len(key) <= MAX_KEY_BYTES:
        raise GateDenied("invalid_key")
    if type(context) is not GateContext:
        raise GateDenied("invalid_context")
    if not (_job(context.job) and _text(context.build_id, _ID)
            and _text(context.source_sha, _SHA) and _project(context.project_id)
            and _text(context.destination_id, _ID) and _text(context.key_id, _ID)
            and context.environment in ("test", "preprod")):
        raise GateDenied("invalid_context")
    if type(ticket) is not dict or set(ticket) != {"payload", "signature"}:
        raise GateDenied("malformed_ticket")
    payload, signature = ticket["payload"], ticket["signature"]
    if type(payload) is not dict or type(payload.get("version")) is not int or payload["version"] not in (1, 2):
        raise GateDenied("malformed_ticket")
    version = payload["version"]
    fields = PAYLOAD_FIELDS if version == 1 else V2_PAYLOAD_FIELDS
    if not (fields <= set(payload) and set(payload) <= fields | {"buildId"}):
        raise GateDenied("malformed_ticket")
    if (not _project(payload["projectId"])
            or not _text(payload["sourceSha"], _SHA)
            or payload["environment"] not in ("test", "preprod")
            or not _text(payload["nonce"], _NONCE)):
        raise GateDenied("malformed_ticket")
    if version == 2 and (not all(_object_sha(payload[name]) for name in ("sourceSha", "targetSha", "expectedTreeSha"))
            or len({len(payload[name]) for name in ("sourceSha", "targetSha", "expectedTreeSha")}) != 1
            or payload["sourceSha"] == payload["targetSha"] or payload["validationProfile"] != "full-verify"):
        raise GateDenied("malformed_merge_plan")
    for name in ("taskId", "grantId", "operationId", "destinationId", "keyId"):
        if not _text(payload[name], _ID):
            raise GateDenied("malformed_ticket")
    if "buildId" in payload and not _text(payload["buildId"], _ID):
        raise GateDenied("malformed_ticket")
    jobs = payload["jobs"]
    if type(jobs) is not list or len(jobs) != 1 or not _job(jobs[0]):
        raise GateDenied("malformed_ticket")
    freezes = payload["freezeWindows"]
    if type(freezes) is not list or len(freezes) > 64:
        raise GateDenied("malformed_freeze")
    windows = [_window(value) for value in freezes] + [_window(RETAINED_FREEZE)]
    issued, begin, expiry = (_time(payload[name]) for name in ("issuedAt", "notBefore", "expiresAt"))
    if not issued <= begin < expiry or expiry - issued > timedelta(seconds=MAX_GRANT_SECONDS):
        raise GateDenied("invalid_window")
    payload_bytes = canonical(payload)
    if len(payload_bytes) > MAX_TICKET_BYTES:
        raise GateDenied("oversized_ticket")
    if type(signature) is not str or re.fullmatch(r"[0-9a-f]{64}", signature, re.ASCII) is None:
        raise GateDenied("invalid_signature")
    expected = hmac.new(key, payload_bytes, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, signature):
        raise GateDenied("invalid_signature")
    if (context.job != jobs[0] or context.project_id != payload["projectId"]
            or (version == 1 and context.source_sha != payload["sourceSha"])
            or context.destination_id != payload["destinationId"]
            or context.environment != payload["environment"]
            or context.key_id != payload["keyId"]
            or ("buildId" in payload and context.build_id != payload["buildId"])):
        raise GateDenied("context_mismatch")
    if version == 2:
        if (not all(_object_sha(value) for value in (context.source_sha, context.approved_source_sha, context.target_sha))
                or context.approved_source_sha != payload["sourceSha"] or context.target_sha != payload["targetSha"]
                or len(context.source_sha) != len(payload["sourceSha"])
                or context.source_sha in (payload["sourceSha"], payload["targetSha"])
                or type(context.parents) is not tuple or len(context.parents) != 2
                or context.parents != (payload["targetSha"], payload["sourceSha"])):
            raise GateDenied("merge_context_mismatch")
        if not preparation and (not _object_sha(context.tree_sha) or context.tree_sha != payload["expectedTreeSha"]
                or context.verification_source_sha != context.source_sha
                or context.verification_profile != payload["validationProfile"]
                or context.verification_passed is not True):
            raise GateDenied("merge_proof_required")
    checked = _clock(now)
    if checked < issued:
        raise GateDenied("future_ticket")
    if checked < begin:
        raise GateDenied("not_yet_valid")
    if checked >= expiry:
        raise GateDenied("expired")
    if any(start <= checked < end for start, end in windows):
        raise GateDenied("frozen")
    deadline = min([expiry] + [start for start, _ in windows if checked < start])
    result = {
        "valid": True, "version": version, "taskId": payload["taskId"],
        "grantId": payload["grantId"], "operationId": payload["operationId"],
        "keyId": context.key_id, "projectId": context.project_id,
        "sourceSha": context.source_sha, "environment": context.environment,
        "destinationId": context.destination_id, "job": context.job,
        "buildId": context.build_id, "ticketDigest": hashlib.sha256(canonical(ticket)).hexdigest(),
        "checkedAt": _stamp(checked), "admissionDeadline": _stamp(deadline),
        "admissionOnly": True, "postAdmissionCancellation": False,
    }
    if version == 2:
        result.update(approvedSourceSha=payload["sourceSha"], deployedSha=context.source_sha,
                      targetSha=payload["targetSha"], expectedTreeSha=payload["expectedTreeSha"],
                      parents=list(context.parents), validationProfile=payload["validationProfile"])
        if not preparation:
            result.update(treeSha=context.tree_sha, verificationPassed=True,
                          verificationSourceSha=context.verification_source_sha)
    return result


def _parts(path: str) -> list[str]:
    if (type(path) is not str or not path.startswith("/") or path.startswith("//")
            or "\x00" in path or os.path.normpath(path) != path or len(path) > 4096):
        raise GateDenied("unsafe_path")
    parts = path.split("/")[1:]
    if any(part in ("", ".", "..") for part in parts):
        raise GateDenied("unsafe_path")
    return parts


def _trusted_directory(fd: int, private: bool = False) -> None:
    info = os.fstat(fd)
    mode = stat.S_IMODE(info.st_mode)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, os.geteuid()):
        raise GateDenied("unsafe_directory")
    if private:
        if info.st_uid != os.geteuid() or mode != 0o700:
            raise GateDenied("unsafe_directory")
    elif mode & 0o022 and not (info.st_uid == 0 and mode & stat.S_ISVTX):
        raise GateDenied("unsafe_directory")


def _directory(parts: list[str], private: bool = False) -> int:
    """Traverse by directory descriptors; never follow a path-component symlink."""
    fd = -1
    try:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        fd = os.open("/", flags)
        _trusted_directory(fd)
        for part in parts:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            _trusted_directory(fd)
        if private:
            _trusted_directory(fd, private=True)
        return fd
    except (OSError, AttributeError):
        if fd >= 0:
            os.close(fd)
        raise GateDenied("unsafe_directory") from None
    except BaseException:
        if fd >= 0:
            os.close(fd)
        raise


def _private_read(path: str, limit: int) -> bytes:
    parts = _parts(path)
    parent = _directory(parts[:-1])
    fd = -1
    try:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(fd)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid not in (0, os.geteuid())
                or stat.S_IMODE(before.st_mode) not in (0o400, 0o600)
                or before.st_nlink != 1):
            raise GateDenied("unsafe_file")
        if before.st_size > limit:
            raise GateDenied("oversized_file")
        chunks, count = [], 0
        while count <= limit:
            chunk = os.read(fd, min(8192, limit + 1 - count))
            if not chunk:
                break
            chunks.append(chunk)
            count += len(chunk)
        after = os.fstat(fd)
        attrs = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
        if any(getattr(before, name) != getattr(after, name) for name in attrs):
            raise GateDenied("file_changed")
        if count > limit:
            raise GateDenied("oversized_file")
        return b"".join(chunks)
    except OSError:
        raise GateDenied("unsafe_file") from None
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(parent)


def _object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise GateDenied("duplicate_json_key")
        result[key] = value
    return result


def _bad_constant(_: str) -> None:
    raise GateDenied("malformed_ticket")


def _ticket(raw: bytes) -> dict[str, Any]:
    try:
        return json.loads(raw.decode("utf-8"), object_pairs_hook=_object, parse_constant=_bad_constant)
    except (UnicodeError, ValueError, RecursionError):
        raise GateDenied("malformed_ticket") from None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _marker_names(payload: dict[str, Any], context: GateContext) -> list[str]:
    def digest(values: list[str]) -> str:
        return hashlib.sha256(canonical(values)).hexdigest()
    return [
        "nonce-" + digest([context.key_id, payload["nonce"]]) + ".json",
        "operation-" + digest([payload["operationId"], context.job]) + ".json",
    ]


def admit(ticket: dict[str, Any], key: bytes, context: GateContext, state_dir: str,
          clock: Callable[[], datetime] = _utcnow) -> dict[str, Any]:
    """Consume durable intent once. Failure after claim is NOT safe to retry."""
    first = _clock(clock())
    metadata = validate(ticket, key, context, first)
    directory = _directory(_parts(state_dir), private=True)
    try:
        markers = _marker_names(ticket["payload"], context)
        receipt = {"state": "intent", "metadata": metadata, "markers": markers}
        receipt_bytes = canonical(receipt)
        receipt_mac = hmac.new(key, b"nightshift-gate-receipt-v1\0" + receipt_bytes,
                               hashlib.sha256).hexdigest()
        raw = canonical({"receipt": receipt, "signature": receipt_mac}) + b"\n"
        for name in markers:
            fd = -1
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=directory)
                os.fchmod(fd, 0o600)
                offset = 0
                while offset < len(raw):
                    written = os.write(fd, raw[offset:])
                    if written <= 0:
                        raise OSError()
                    offset += written
                os.fsync(fd)
            except FileExistsError:
                raise GateDenied("replay_or_unknown") from None
            finally:
                if fd >= 0:
                    os.close(fd)
            os.fsync(directory)
        final = _clock(clock())
        if final < first:
            raise GateDenied("clock_regressed")
        # A queue/disk stall crossing expiry or freeze must deny, never use first.
        # Even a stall spanning an ENTIRE freeze cannot silently resume at thaw.
        initial_deadline = _time(metadata["admissionDeadline"])
        metadata = validate(ticket, key, context, final)
        if final >= initial_deadline:
            raise GateDenied("window_elapsed")
        return {**metadata, "allowed": True, "intentMarkers": markers}
    except OSError:
        raise GateDenied("state_unavailable") from None
    finally:
        os.close(directory)


class _Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        # argparse normally prints raw argv values, potentially supplied secrets.
        raise GateDenied("invalid_arguments")


def main(argv: list[str] | None = None) -> int:
    try:
        # There is no --help success path: exit 0 always means an actual admission.
        parser = _Parser(description="Single-use offline Jenkins write-admission gate",
                         allow_abbrev=False, add_help=False)
        options = ("ticket", "key-file", "job", "build-id", "source-sha", "project-id",
                   "destination", "environment", "key-id", "state-dir")
        raw_argv = sys.argv[1:] if argv is None else argv
        for option in options:
            flag = "--" + option
            if sum(value == flag or value.startswith(flag + "=") for value in raw_argv) != 1:
                raise GateDenied("invalid_arguments")
            parser.add_argument(flag, required=True)
        args = parser.parse_args(raw_argv)
        if re.fullmatch(r"[1-9][0-9]{0,15}", args.project_id, re.ASCII) is None:
            raise GateDenied("invalid_context")
        context = GateContext(job=args.job, build_id=args.build_id, source_sha=args.source_sha,
                              project_id=int(args.project_id), destination_id=args.destination,
                              environment=args.environment, key_id=args.key_id)
        # No key material is emitted on any path; generic denial codes only.
        key = _private_read(args.key_file, MAX_KEY_BYTES)
        ticket = _ticket(_private_read(args.ticket, MAX_TICKET_BYTES))
        result = admit(ticket, key, context, args.state_dir)
        print(json.dumps(result, sort_keys=True, separators=(",", ":")))
        return 0
    except GateDenied as error:
        print(json.dumps({"allowed": False, "reason": str(error)}, separators=(",", ":")))
        return 1
    except Exception:
        print('{"allowed":false,"reason":"internal_error"}')
        return 1


if __name__ == "__main__":
    sys.exit(main())
