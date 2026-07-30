#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import pathlib
import sqlite3
import sys
import time
import urllib.request

from relay_sync_core import (
    apply_database_plan,
    build_pending_journal,
    build_rollback_plans,
    build_target_registry,
    recover_pending_journal,
    rollback_managed_bindings,
    scan_connections,
    summarize_plans,
    validate_bindings_state,
    write_json_atomic,
)


def utc_now():
    return (
        dt.datetime.now(dt.timezone.utc)
        .isoformat(timespec='milliseconds')
        .replace('+00:00', 'Z')
    )


def load_json(path, default):
    filename = pathlib.Path(path)
    if not filename.exists():
        return default
    return json.loads(filename.read_text(encoding='utf8'))


def connect_database(path, *, writable):
    if writable:
        return sqlite3.connect(path, timeout=30, isolation_level=None)
    database_uri = pathlib.Path(path).resolve().as_uri() + '?mode=ro'
    return sqlite3.connect(
        database_uri,
        timeout=30,
        isolation_level=None,
        uri=True,
    )


def wait_ready(url, generation, timeout_seconds):
    deadline = time.monotonic() + timeout_seconds
    last_error = 'not ready'
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                payload = json.load(response)
            if (
                isinstance(payload, dict)
                and payload.get('ok') is True
                and payload.get('generation') == generation
            ):
                return
            last_error = 'generation mismatch'
        except Exception as error:
            last_error = type(error).__name__
        time.sleep(0.25)
    raise RuntimeError(
        f'header-relay readiness failed: {last_error}'
    )


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=(
            'Synchronize eligible 9router connections to header-relay.'
        )
    )
    parser.add_argument(
        '--config', default='/opt/header-relay/config.json')
    action = parser.add_mutually_exclusive_group()
    action.add_argument('--apply', action='store_true')
    action.add_argument('--rollback-managed', action='store_true')
    parser.add_argument(
        '--only-connection-id', action='append', default=[])
    parser.add_argument(
        '--ready-url', default='http://127.0.0.1:20130/ready')
    parser.add_argument('--ready-timeout', type=float, default=15.0)
    args = parser.parse_args(argv)

    config_path = pathlib.Path(args.config).resolve()
    config = load_json(config_path, None)
    if not isinstance(config, dict):
        raise RuntimeError('invalid relay config')
    sync_config = config['sync']
    forward_config = config['forward']
    token = pathlib.Path(forward_config['tokenFile']).read_text(
        encoding='utf8').strip()
    if not token:
        raise RuntimeError('relay token is empty')

    state_directory = pathlib.Path(forward_config['targetsFile']).parent
    bindings_path = state_directory / 'bindings.json'
    pending_path = state_directory / 'bindings.pending.json'
    pool_id = sync_config['managedProxyPoolId']
    bindings = validate_bindings_state(
        load_json(bindings_path, {
            'schemaVersion': 1,
            'poolId': pool_id,
            'connections': {},
        }),
        pool_id,
    )

    if args.only_connection_id:
        allowed = set(args.only_connection_id)
    else:
        allowed = set(sync_config.get('includeConnectionIds') or [])
    if allowed:
        allowed.update((bindings.get('connections') or {}).keys())
        sync_config = dict(sync_config)
        sync_config['includeConnectionIds'] = sorted(allowed)

    db = connect_database(
        sync_config['dbPath'],
        writable=args.apply or args.rollback_managed,
    )
    try:
        db.execute('PRAGMA busy_timeout=5000')
        recovery = recover_pending_journal(
            db,
            pending_path,
            bindings_path,
            pool_id,
            mutate=args.apply or args.rollback_managed,
        )
        if recovery == 'committed':
            if args.apply or args.rollback_managed:
                recovered_bindings = load_json(bindings_path, bindings)
            else:
                pending = load_json(pending_path, None)
                recovered_bindings = pending.get('bindingsAfter')
            bindings = validate_bindings_state(
                recovered_bindings, pool_id)

        if args.rollback_managed:
            rollback_plans = build_rollback_plans(
                db, bindings, pool_id)
            journal = build_pending_journal(
                db, rollback_plans, bindings, pool_id)
            rollback_bindings = {
                'schemaVersion': 1,
                'poolId': pool_id,
                'connections': {},
            }
            journal['bindingsAfter'] = rollback_bindings
            write_json_atomic(pending_path, journal)
            result = rollback_managed_bindings(
                db, bindings, pool_id, utc_now())
            journal['bindingsAfter'] = result['bindings']
            write_json_atomic(pending_path, journal)
            write_json_atomic(bindings_path, result['bindings'])
            pending_path.unlink(missing_ok=True)
            print(json.dumps({
                'mode': 'rollback-managed',
                'databaseChanges': result['databaseChanges'],
                'restoredConnections': len(rollback_plans),
            }, ensure_ascii=False, sort_keys=True))
            return 0

        plans = scan_connections(db, sync_config, bindings)
        registry = build_target_registry(plans, utc_now())
        summary = {
            'mode': 'apply' if args.apply else 'dry-run',
            'generation': registry['generation'],
            'targets': len(registry['rules']),
            'plans': summarize_plans(plans),
            'recovery': recovery,
        }
        if not args.apply:
            print(json.dumps(
                summary, ensure_ascii=False, sort_keys=True))
            return 0

        write_json_atomic(forward_config['targetsFile'], registry)
        wait_ready(
            args.ready_url,
            registry['generation'],
            args.ready_timeout,
        )

        journal = build_pending_journal(
            db, plans, bindings, pool_id)
        write_json_atomic(pending_path, journal)
        proxy_url = (
            f"http://127.0.0.1:{config['listen']['port']}"
            f"{forward_config['pathPrefix']}/{token}"
        )
        applied = apply_database_plan(
            db,
            plans,
            bindings,
            pool_id,
            proxy_url,
            utc_now(),
        )
        journal['bindingsAfter'] = applied['bindings']
        write_json_atomic(pending_path, journal)
        write_json_atomic(bindings_path, applied['bindings'])
        pending_path.unlink(missing_ok=True)

        summary['databaseChanges'] = applied['databaseChanges']
        print(json.dumps(summary, ensure_ascii=False, sort_keys=True))
        return 0
    finally:
        db.close()


if __name__ == '__main__':
    sys.exit(main())
