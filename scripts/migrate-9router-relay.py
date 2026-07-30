#!/usr/bin/env python3
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import sqlite3
import sys
import urllib.parse

from relay_sync_core import canonical_json, provider_family, write_json_atomic


LOOPBACK_HOSTS = {'127.0.0.1', 'localhost', '::1'}


def utc_now():
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec='milliseconds')
        .replace('+00:00', 'Z')
    )


def connect_database(path, *, writable):
    if writable:
        return sqlite3.connect(path, timeout=30)
    database_uri = pathlib.Path(path).resolve().as_uri() + '?mode=ro'
    return sqlite3.connect(database_uri, timeout=30, uri=True)


def _split_url(value, message):
    raw = str(value or '')
    if '\r' in raw or '\n' in raw:
        raise RuntimeError(message)
    try:
        parsed = urllib.parse.urlsplit(raw)
        _ = parsed.hostname
        _ = parsed.port
    except (TypeError, ValueError, UnicodeError):
        raise RuntimeError(message) from None
    return parsed


def is_local_relay_url(value):
    try:
        parsed = _split_url(value, 'invalid legacy Base URL')
    except RuntimeError:
        return False
    return (
        parsed.scheme.lower() in ('http', 'https')
        and parsed.hostname is not None
        and parsed.hostname.lower() in LOOPBACK_HOSTS
        and parsed.port == 20130
    )


def _route_match(pathname, prefix):
    if prefix == '/':
        return pathname.startswith('/')
    return pathname == prefix or pathname.startswith(prefix + '/')


def map_legacy_url(value, routes):
    parsed = _split_url(value, 'invalid legacy Base URL')
    if parsed.username or parsed.password:
        raise RuntimeError('legacy relay Base URL credentials are unsupported')
    if parsed.query or parsed.fragment:
        raise RuntimeError(
            'legacy relay Base URL query or fragment is unsupported')

    matches = []
    for route in routes:
        if not isinstance(route, dict):
            continue
        prefix = str(route.get('prefix') or '').rstrip('/') or '/'
        if not prefix.startswith('/') or not _route_match(parsed.path, prefix):
            continue
        matches.append((len(prefix), prefix, route.get('target')))
    matches.sort(key=lambda item: item[0], reverse=True)
    if not matches or (
        len(matches) > 1 and matches[0][0] == matches[1][0]
    ):
        path_hash = hashlib.sha256(parsed.path.encode()).hexdigest()[:12]
        raise RuntimeError(
            f'no unique legacy route for local relay path hash={path_hash}')

    _length, prefix, target_value = matches[0]
    target = _split_url(
        target_value, 'legacy route target is not a safe absolute Base URL')
    if (
        target.scheme.lower() not in ('http', 'https')
        or not target.hostname
        or target.username
        or target.password
        or target.query
        or target.fragment
    ):
        raise RuntimeError(
            'legacy route target is not a safe absolute Base URL')

    suffix = parsed.path[len(prefix):]
    base_path = target.path.rstrip('/')
    new_path = (base_path + suffix) or '/'
    return urllib.parse.urlunsplit((
        target.scheme,
        target.netloc,
        new_path,
        '',
        '',
    ))


def _json_object(raw_data, message):
    try:
        value = json.loads(raw_data)
    except (TypeError, ValueError, UnicodeError):
        raise RuntimeError(message) from None
    if not isinstance(value, dict):
        raise RuntimeError(message)
    return value


def plan_changes(db, config):
    routes = config.get('routes') or []
    if not isinstance(routes, list):
        raise RuntimeError('invalid legacy route configuration')
    changes = []

    for record_id, node_type, raw_data in db.execute(
        'SELECT id,type,data FROM providerNodes ORDER BY id'
    ):
        if node_type not in ('openai-compatible', 'anthropic-compatible'):
            continue
        data = _json_object(raw_data, 'invalid provider node data')
        old_value = data.get('baseUrl')
        if is_local_relay_url(old_value):
            changes.append({
                'table': 'providerNodes',
                'id': record_id,
                'field': 'baseUrl',
                'oldBaseUrl': old_value,
                'newBaseUrl': map_legacy_url(old_value, routes),
            })

    for record_id, provider, raw_data in db.execute(
        'SELECT id,provider,data FROM providerConnections ORDER BY id'
    ):
        if provider_family(provider) is None:
            continue
        data = _json_object(raw_data, 'invalid provider connection data')
        provider_data = data.get('providerSpecificData')
        if not isinstance(provider_data, dict):
            raise RuntimeError('invalid provider connection data')
        old_value = provider_data.get('baseUrl')
        if is_local_relay_url(old_value):
            changes.append({
                'table': 'providerConnections',
                'id': record_id,
                'field': 'providerSpecificData.baseUrl',
                'oldBaseUrl': old_value,
                'newBaseUrl': map_legacy_url(old_value, routes),
            })
    return changes


def backup_database(db, database_path):
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%d-%H%M%S')
    database_path = pathlib.Path(database_path)
    candidate = database_path.with_name(
        f'{database_path.name}.bak-{stamp}-before-header-relay-pool')
    suffix = 1
    while candidate.exists():
        candidate = database_path.with_name(
            f'{database_path.name}.bak-{stamp}-{suffix}'
            '-before-header-relay-pool')
        suffix += 1

    backup = sqlite3.connect(candidate)
    try:
        db.backup(backup)
    except Exception:
        backup.close()
        candidate.unlink(missing_ok=True)
        raise
    else:
        backup.close()
    candidate.chmod(0o600)
    digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
    return candidate, digest


def replace_base_url(data, field, value):
    next_data = dict(data)
    if field == 'baseUrl':
        next_data['baseUrl'] = value
    else:
        provider_data = dict(next_data.get('providerSpecificData') or {})
        provider_data['baseUrl'] = value
        next_data['providerSpecificData'] = provider_data
    return next_data


def read_base_url(data, field):
    if field == 'baseUrl':
        return data.get('baseUrl')
    provider_data = data.get('providerSpecificData')
    if not isinstance(provider_data, dict):
        return None
    return provider_data.get('baseUrl')


def validate_change(change):
    if not isinstance(change, dict):
        raise RuntimeError('invalid migration change target')
    expected_field = {
        'providerNodes': 'baseUrl',
        'providerConnections': 'providerSpecificData.baseUrl',
    }.get(change.get('table'))
    if (
        expected_field is None
        or change.get('field') != expected_field
        or not isinstance(change.get('id'), str)
        or not isinstance(change.get('oldBaseUrl'), str)
        or not isinstance(change.get('newBaseUrl'), str)
    ):
        raise RuntimeError('invalid migration change target')


def apply_values(db, changes, value_key, expected_key, now):
    db.execute('PRAGMA busy_timeout=5000')
    db.execute('BEGIN IMMEDIATE')
    try:
        for change in changes:
            validate_change(change)
            row = db.execute(
                f"SELECT data FROM {change['table']} WHERE id=?",
                (change['id'],),
            ).fetchone()
            if row is None:
                raise RuntimeError('migration record missing')
            data = _json_object(row[0], 'invalid migration record data')
            if read_base_url(data, change['field']) != change[expected_key]:
                raise RuntimeError(
                    'migration record changed since migration plan')
            next_data = replace_base_url(
                data, change['field'], change[value_key])
            db.execute(
                f"UPDATE {change['table']} SET data=?,updatedAt=? WHERE id=?",
                (canonical_json(next_data), now, change['id']),
            )
        db.commit()
    except Exception:
        db.rollback()
        raise


def apply_migration(
    db,
    database_path,
    changes,
    state_path,
    manifest_path,
    now,
):
    for change in changes:
        validate_change(change)
    backup_path, backup_sha256 = backup_database(db, database_path)
    state = {
        'schemaVersion': 1,
        'createdAt': now,
        'changes': changes,
    }
    manifest = {
        'schemaVersion': 1,
        'createdAt': now,
        'backupPath': str(backup_path),
        'backupSha256': backup_sha256,
        'changes': [
            {
                'table': change['table'],
                'id': change['id'],
                'oldSha256': hashlib.sha256(
                    change['oldBaseUrl'].encode()).hexdigest(),
                'newSha256': hashlib.sha256(
                    change['newBaseUrl'].encode()).hexdigest(),
            }
            for change in changes
        ],
    }
    write_json_atomic(state_path, state, mode=0o600)
    write_json_atomic(manifest_path, manifest, mode=0o600)
    apply_values(db, changes, 'newBaseUrl', 'oldBaseUrl', now)

    for change in changes:
        row = db.execute(
            f"SELECT data FROM {change['table']} WHERE id=?",
            (change['id'],),
        ).fetchone()
        if row is None:
            raise RuntimeError('post-migration verification failed')
        data = _json_object(row[0], 'post-migration verification failed')
        if read_base_url(data, change['field']) != change['newBaseUrl']:
            raise RuntimeError('post-migration verification failed')
    return {
        'changed': len(changes),
        'backupPath': str(backup_path),
        'backupSha256': backup_sha256,
    }


def rollback_migration(db, state_path, now):
    try:
        state = json.loads(pathlib.Path(state_path).read_text(encoding='utf8'))
    except (OSError, TypeError, ValueError, UnicodeError):
        raise RuntimeError('invalid migration state') from None
    if (
        not isinstance(state, dict)
        or state.get('schemaVersion') != 1
        or not isinstance(state.get('changes'), list)
    ):
        raise RuntimeError('invalid migration state')
    for change in state['changes']:
        validate_change(change)
    apply_values(db, state['changes'], 'oldBaseUrl', 'newBaseUrl', now)
    return {'restored': len(state['changes'])}


def safe_plan(changes):
    safe = []
    for change in changes:
        validate_change(change)
        safe.append({
            'table': change['table'],
            'id': change['id'],
            'oldSha256': hashlib.sha256(
                change['oldBaseUrl'].encode()).hexdigest(),
            'newSha256': hashlib.sha256(
                change['newBaseUrl'].encode()).hexdigest(),
        })
    return safe


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            'Restore legacy header-relay Base URLs before proxy-pool binding.'
        )
    )
    parser.add_argument('--config', default='/opt/header-relay/config.json')
    parser.add_argument('--db', default='/root/.9router/db/data.sqlite')
    parser.add_argument(
        '--state', default='/var/lib/header-relay/migration-state.json')
    parser.add_argument(
        '--manifest', default='/var/lib/header-relay/migration-manifest.json')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args(argv)

    db = connect_database(
        args.db,
        writable=args.apply or args.rollback,
    )
    try:
        if args.rollback:
            result = rollback_migration(db, args.state, utc_now())
        else:
            try:
                config = json.loads(
                    pathlib.Path(args.config).read_text(encoding='utf8'))
            except (OSError, TypeError, ValueError, UnicodeError):
                raise RuntimeError('invalid relay configuration') from None
            if not isinstance(config, dict):
                raise RuntimeError('invalid relay configuration')
            changes = plan_changes(db, config)
            result = {
                'mode': 'apply' if args.apply else 'dry-run',
                'changes': safe_plan(changes),
            }
            if args.apply and changes:
                result.update(apply_migration(
                    db,
                    pathlib.Path(args.db),
                    changes,
                    pathlib.Path(args.state),
                    pathlib.Path(args.manifest),
                    utc_now(),
                ))
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    finally:
        db.close()


if __name__ == '__main__':
    sys.exit(main())
