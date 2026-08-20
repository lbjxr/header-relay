from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import pathlib
import posixpath
import re
import tempfile
import urllib.parse


INCLUDE_PREFIXES = (
    'openai-compatible-chat-',
    'openai-compatible-responses-',
    'anthropic-compatible-',
)
MAX_PATH_DECODE_PASSES = 4


def _dangerous_path_segment(segment):
    return (
        '/' in segment
        or '\\' in segment
        or segment in ('.', '..')
    )


def _ambiguous_path_encoding(pathname):
    for original_segment in pathname.split('/'):
        segment = original_segment
        for _pass in range(MAX_PATH_DECODE_PASSES):
            if _dangerous_path_segment(segment):
                return True
            if re.search(r'%[0-9a-f]{2}', segment, flags=re.IGNORECASE) is None:
                break
            if re.search(r'%(?![0-9a-f]{2})', segment, flags=re.IGNORECASE):
                return True
            try:
                segment = urllib.parse.unquote(
                    segment,
                    encoding='utf-8',
                    errors='strict',
                )
            except (UnicodeDecodeError, UnicodeError):
                return True

        if (
            _dangerous_path_segment(segment)
            or re.search(r'%(?:25|2f|5c)', segment, flags=re.IGNORECASE)
            or re.fullmatch(r'(?:\.|%2e){1,2}', segment, flags=re.IGNORECASE)
        ):
            return True
    return False


@dataclasses.dataclass(frozen=True)
class ConnectionPlan:
    connection_id: str
    provider: str
    family: str | None
    action: str
    reason: str
    origin: str | None = None
    base_path: str | None = None
    context1m: bool = True
    previous_proxy_pool_id: str | None = None
    expected_proxy_pool_id: str | None = None


def provider_family(provider):
    if not isinstance(provider, str):
        return None
    if provider.startswith(INCLUDE_PREFIXES[0]):
        return 'openai-chat'
    if provider.startswith(INCLUDE_PREFIXES[1]):
        return 'openai-responses'
    if provider.startswith(INCLUDE_PREFIXES[2]):
        return 'anthropic'
    return None


def normalize_base_url(value):
    try:
        raw_value = str(value or '').strip()
        if '\r' in raw_value or '\n' in raw_value or '\\' in raw_value:
            raise ValueError
        if '?' in raw_value or '#' in raw_value:
            raise ValueError

        parsed = urllib.parse.urlsplit(raw_value)
        scheme = parsed.scheme.lower()
        hostname = parsed.hostname
        if scheme not in ('http', 'https') or not hostname:
            raise ValueError
        if parsed.username is not None or parsed.password is not None:
            raise ValueError
        if parsed.query or parsed.fragment:
            raise ValueError
        hostname = hostname.lower()
        if ':' not in hostname:
            hostname = hostname.encode('idna').decode('ascii').lower()
        rendered_host = f'[{hostname}]' if ':' in hostname else hostname

        port = parsed.port
        default_port = 80 if scheme == 'http' else 443
        if port is not None and port != default_port:
            rendered_host = f'{rendered_host}:{port}'
        origin = f'{scheme}://{rendered_host}'

        raw_path = parsed.path or '/'
        normalized = posixpath.normpath('/' + raw_path.lstrip('/'))
        base_path = '/' if normalized == '/' else normalized.rstrip('/')
        if _ambiguous_path_encoding(base_path):
            raise ValueError
        return origin, base_path
    except (TypeError, ValueError, UnicodeError):
        raise ValueError('invalid_base_url') from None


def scan_connections(db, sync_config, bindings):
    managed_pool_id = str(sync_config['managedProxyPoolId'])
    excluded = set(sync_config.get('excludeConnectionIds') or [])
    included = set(sync_config.get('includeConnectionIds') or [])
    overrides = sync_config.get('targetOverrides') or {}
    if not isinstance(overrides, dict):
        overrides = {}

    managed_before = {}
    if isinstance(bindings, dict) and isinstance(bindings.get('connections'), dict):
        managed_before = bindings['connections']

    plans = []
    rows = db.execute(
        'SELECT id, provider, isActive, data FROM providerConnections ORDER BY id'
    ).fetchall()
    for connection_id, provider, _is_active, raw_data in rows:
        family = provider_family(provider)
        if family is None:
            continue
        if included and connection_id not in included:
            plans.append(ConnectionPlan(
                connection_id,
                provider,
                family,
                'skip',
                'canary_excluded',
            ))
            continue

        try:
            data = json.loads(raw_data)
            if not isinstance(data, dict):
                raise ValueError
            provider_data = data.get('providerSpecificData')
            if not isinstance(provider_data, dict):
                raise ValueError
        except (TypeError, ValueError, UnicodeError):
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'invalid_data_json'
            ))
            continue

        current_pool = str(provider_data.get('proxyPoolId') or '').strip() or None
        previous = None
        previous_state = managed_before.get(connection_id)
        if isinstance(previous_state, dict):
            stored_previous = previous_state.get('previousProxyPoolId')
            if stored_previous is None or isinstance(stored_previous, str):
                previous = stored_previous

        if connection_id in excluded:
            action = (
                'unbind'
                if current_pool == managed_pool_id and connection_id in managed_before
                else 'skip'
            )
            plans.append(ConnectionPlan(
                connection_id=connection_id,
                provider=provider,
                family=family,
                action=action,
                reason='excluded',
                previous_proxy_pool_id=previous,
                expected_proxy_pool_id=current_pool,
            ))
            continue

        if current_pool == '__none__':
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'explicit_none'
            ))
            continue
        if current_pool and current_pool != managed_pool_id:
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'other_proxy_pool'
            ))
            continue
        if (
            provider_data.get('connectionProxyEnabled') is True
            and str(provider_data.get('connectionProxyUrl') or '').strip()
        ):
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'legacy_proxy'
            ))
            continue

        try:
            origin, base_path = normalize_base_url(provider_data.get('baseUrl'))
        except ValueError:
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'invalid_base_url'
            ))
            continue

        parsed_origin = urllib.parse.urlsplit(origin)
        default_port = 80 if parsed_origin.scheme == 'http' else 443
        effective_port = parsed_origin.port
        if effective_port is None:
            effective_port = default_port
        if (
            parsed_origin.hostname in ('127.0.0.1', 'localhost', '::1')
            and effective_port == 20130
        ):
            plans.append(ConnectionPlan(
                connection_id, provider, family, 'skip', 'relay_loop'
            ))
            continue

        override = overrides.get(connection_id)
        context1m = not (
            isinstance(override, dict) and override.get('context1m') is False
        )
        is_managed = current_pool == managed_pool_id
        plans.append(ConnectionPlan(
            connection_id=connection_id,
            provider=provider,
            family=family,
            action='keep' if is_managed else 'bind',
            reason='managed' if is_managed else 'eligible',
            origin=origin,
            base_path=base_path,
            context1m=context1m,
            previous_proxy_pool_id=previous,
            expected_proxy_pool_id=current_pool,
        ))

    return plans


def build_target_registry(plans, generated_at):
    grouped = {}
    for plan in plans:
        if plan.action not in ('bind', 'keep'):
            continue
        key = (plan.origin, plan.base_path)
        item = grouped.setdefault(key, {
            'connectionIds': [],
            'families': set(),
            'context1m': True,
        })
        item['connectionIds'].append(plan.connection_id)
        item['families'].add(plan.family)
        if plan.context1m is False:
            item['context1m'] = False

    rules = []
    for (origin, base_path), item in sorted(grouped.items()):
        digest = hashlib.sha256(
            f'{origin}\0{base_path}'.encode()
        ).hexdigest()[:16]
        rules.append({
            'ruleId': f'target-{digest}',
            'connectionIds': sorted(item['connectionIds']),
            'origin': origin,
            'basePath': base_path,
            'families': sorted(item['families']),
            'overrides': {'context1m': item['context1m']},
        })

    canonical_rules = json.dumps(
        rules, ensure_ascii=False, sort_keys=True, separators=(',', ':')
    )
    generation = 'sha256:' + hashlib.sha256(canonical_rules.encode()).hexdigest()
    return {
        'schemaVersion': 1,
        'generation': generation,
        'generatedAt': generation,
        'rules': rules,
    }


def summarize_plans(plans):
    counts = {}
    for plan in plans:
        key = plan.action if plan.action != 'skip' else f'skip:{plan.reason}'
        counts[key] = counts.get(key, 0) + 1
    return dict(sorted(counts.items()))


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(',', ':'),
    )


MANAGED_POOL_NAME = 'Header Relay (managed)'


def assert_managed_pool_identity(value):
    if (
        not isinstance(value, dict)
        or value.get('name') != MANAGED_POOL_NAME
        or value.get('type') != 'vercel'
    ):
        raise RuntimeError('managed proxy pool id collision')


def validate_bindings_state(value, pool_id):
    if (
        not isinstance(value, dict)
        or type(value.get('schemaVersion')) is not int
        or value.get('schemaVersion') != 1
    ):
        raise RuntimeError('invalid bindings schemaVersion')
    stored_pool_id = value.get('poolId')
    if type(stored_pool_id) is not type(pool_id) or stored_pool_id != pool_id:
        raise RuntimeError(
            'bindings poolId does not match managedProxyPoolId'
        )
    connections = value.get('connections')
    if not isinstance(connections, dict):
        raise RuntimeError('invalid bindings connections')
    for connection_id, state in connections.items():
        if not isinstance(connection_id, str) or not isinstance(state, dict):
            raise RuntimeError('invalid bindings connection state')
        previous = state.get('previousProxyPoolId')
        if previous is not None and not isinstance(previous, str):
            raise RuntimeError('invalid previousProxyPoolId')
    return value


def write_json_atomic(path, value, mode=0o600):
    destination = pathlib.Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f'.{destination.name}.',
        dir=destination.parent,
    )
    try:
        with os.fdopen(descriptor, 'w', encoding='utf8') as handle:
            handle.write(canonical_json(value))
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, destination)
        directory_flags = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0)
        directory_descriptor = os.open(destination.parent, directory_flags)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def desired_pool_data(proxy_url, existing=None):
    value = dict(existing or {})
    value.update({
        'name': MANAGED_POOL_NAME,
        'proxyUrl': proxy_url,
        'noProxy': '',
        'type': 'vercel',
        'strictProxy': True,
    })
    value.setdefault('lastTestedAt', None)
    value.setdefault('lastError', None)
    return value


def build_bindings_after(plans, current_bindings, pool_id):
    connections = dict(current_bindings.get('connections') or {})
    for plan in plans:
        if plan.action == 'bind':
            connections[plan.connection_id] = {
                'previousProxyPoolId': plan.previous_proxy_pool_id,
            }
        elif (
            plan.action == 'unbind'
            or (plan.action == 'skip' and plan.reason == 'other_proxy_pool')
        ):
            connections.pop(plan.connection_id, None)
    return {
        'schemaVersion': 1,
        'poolId': pool_id,
        'connections': dict(sorted(connections.items())),
    }


def _connection_data(raw_data):
    try:
        data = json.loads(raw_data)
        if not isinstance(data, dict):
            raise ValueError
        provider_data = data.get('providerSpecificData')
        if not isinstance(provider_data, dict):
            raise ValueError
    except (TypeError, ValueError, UnicodeError):
        raise RuntimeError('invalid connection data during sync') from None
    return data, provider_data


def _current_proxy_pool_id(provider_data):
    return str(provider_data.get('proxyPoolId') or '').strip() or None


def apply_database_plan(db, plans, current_bindings, pool_id, proxy_url, now):
    changes = 0
    bindings_after = build_bindings_after(
        plans, current_bindings, pool_id)
    db.execute('PRAGMA busy_timeout=5000')
    db.execute('BEGIN IMMEDIATE')
    try:
        row = db.execute(
            'SELECT isActive,testStatus,data,createdAt,updatedAt '
            'FROM proxyPools WHERE id=?',
            (pool_id,),
        ).fetchone()
        if row is None:
            pool_data = desired_pool_data(proxy_url)
            db.execute(
                'INSERT INTO proxyPools('
                'id,isActive,testStatus,data,createdAt,updatedAt'
                ') VALUES(?,?,?,?,?,?)',
                (
                    pool_id,
                    1,
                    'unknown',
                    canonical_json(pool_data),
                    now,
                    now,
                ),
            )
            changes += 1
        else:
            try:
                current_pool_data = json.loads(row[2])
            except (TypeError, ValueError, UnicodeError):
                raise RuntimeError(
                    'managed proxy pool id collision'
                ) from None
            assert_managed_pool_identity(current_pool_data)
            next_pool_data = desired_pool_data(proxy_url, current_pool_data)
            if (
                row[0] != 1
                or canonical_json(current_pool_data)
                != canonical_json(next_pool_data)
            ):
                db.execute(
                    'UPDATE proxyPools '
                    'SET isActive=1,data=?,updatedAt=? WHERE id=?',
                    (canonical_json(next_pool_data), now, pool_id),
                )
                changes += 1

        for plan in plans:
            if plan.action not in ('bind', 'unbind'):
                continue
            row = db.execute(
                'SELECT data FROM providerConnections WHERE id=?',
                (plan.connection_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError('connection disappeared during sync')
            data, provider_data = _connection_data(row[0])
            current_pool_id = _current_proxy_pool_id(provider_data)
            if current_pool_id != plan.expected_proxy_pool_id:
                raise RuntimeError('connection changed after scan')

            next_provider_data = dict(provider_data)
            if plan.action == 'bind':
                next_provider_data['proxyPoolId'] = pool_id
            elif plan.previous_proxy_pool_id is not None:
                next_provider_data['proxyPoolId'] = (
                    plan.previous_proxy_pool_id
                )
            else:
                next_provider_data.pop('proxyPoolId', None)
            next_data = dict(data)
            next_data['providerSpecificData'] = next_provider_data

            if canonical_json(data) != canonical_json(next_data):
                db.execute(
                    'UPDATE providerConnections '
                    'SET data=?,updatedAt=? WHERE id=?',
                    (canonical_json(next_data), now, plan.connection_id),
                )
                changes += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        'databaseChanges': changes,
        'bindings': bindings_after,
    }


def build_rollback_plans(db, bindings, pool_id):
    plans = []
    connections = bindings.get('connections') or {}
    for connection_id, state in sorted(connections.items()):
        row = db.execute(
            'SELECT provider,data FROM providerConnections WHERE id=?',
            (connection_id,),
        ).fetchone()
        if row is None:
            continue
        provider, raw_data = row
        _data, provider_data = _connection_data(raw_data)
        if _current_proxy_pool_id(provider_data) != pool_id:
            continue
        plans.append(ConnectionPlan(
            connection_id=connection_id,
            provider=provider,
            family=provider_family(provider),
            action='unbind',
            reason='rollback',
            previous_proxy_pool_id=state.get('previousProxyPoolId'),
            expected_proxy_pool_id=pool_id,
        ))
    return plans


def rollback_managed_bindings(db, bindings, pool_id, now):
    validate_bindings_state(bindings, pool_id)
    db.execute('PRAGMA busy_timeout=5000')
    db.execute('BEGIN IMMEDIATE')
    changes = 0
    try:
        plans = build_rollback_plans(db, bindings, pool_id)
        for plan in plans:
            row = db.execute(
                'SELECT data FROM providerConnections WHERE id=?',
                (plan.connection_id,),
            ).fetchone()
            if row is None:
                raise RuntimeError(
                    'connection disappeared during rollback'
                )
            data, provider_data = _connection_data(row[0])
            current_pool_id = _current_proxy_pool_id(provider_data)
            if current_pool_id != plan.expected_proxy_pool_id:
                raise RuntimeError('connection changed after scan')

            next_provider_data = dict(provider_data)
            if plan.previous_proxy_pool_id is not None:
                next_provider_data['proxyPoolId'] = (
                    plan.previous_proxy_pool_id
                )
            else:
                next_provider_data.pop('proxyPoolId', None)
            next_data = dict(data)
            next_data['providerSpecificData'] = next_provider_data
            if canonical_json(data) != canonical_json(next_data):
                db.execute(
                    'UPDATE providerConnections '
                    'SET data=?,updatedAt=? WHERE id=?',
                    (
                        canonical_json(next_data),
                        now,
                        plan.connection_id,
                    ),
                )
                changes += 1

        pool_row = db.execute(
            'SELECT isActive,data FROM proxyPools WHERE id=?',
            (pool_id,),
        ).fetchone()
        if pool_row is not None:
            try:
                pool_data = json.loads(pool_row[1])
            except (TypeError, ValueError, UnicodeError):
                raise RuntimeError(
                    'managed proxy pool id collision'
                ) from None
            assert_managed_pool_identity(pool_data)
            if pool_row[0] != 0:
                db.execute(
                    'UPDATE proxyPools '
                    'SET isActive=0,updatedAt=? WHERE id=?',
                    (now, pool_id),
                )
                changes += 1
        db.commit()
    except Exception:
        db.rollback()
        raise
    return {
        'databaseChanges': changes,
        'bindings': {
            'schemaVersion': 1,
            'poolId': pool_id,
            'connections': {},
        },
    }


def build_pending_journal(db, plans, current_bindings, pool_id):
    before = {}
    after = {}
    for plan in plans:
        if plan.action not in ('bind', 'unbind'):
            continue
        row = db.execute(
            'SELECT data FROM providerConnections WHERE id=?',
            (plan.connection_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError('connection disappeared during sync')
        _data, provider_data = _connection_data(row[0])
        current_pool_id = _current_proxy_pool_id(provider_data)
        if current_pool_id != plan.expected_proxy_pool_id:
            raise RuntimeError('connection changed after scan')
        before[plan.connection_id] = current_pool_id
        after[plan.connection_id] = (
            pool_id
            if plan.action == 'bind'
            else plan.previous_proxy_pool_id
        )
    return {
        'schemaVersion': 1,
        'poolId': pool_id,
        'before': dict(sorted(before.items())),
        'after': dict(sorted(after.items())),
        'bindingsAfter': build_bindings_after(
            plans, current_bindings, pool_id),
    }


def _validated_pending_journal(pending_path, expected_pool_id):
    try:
        journal = json.loads(pending_path.read_text(encoding='utf8'))
    except (OSError, TypeError, ValueError, UnicodeError):
        raise RuntimeError('invalid pending journal state') from None
    if not isinstance(journal, dict):
        raise RuntimeError('invalid pending journal state')
    if (
        type(journal.get('schemaVersion')) is not int
        or journal.get('schemaVersion') != 1
        or type(journal.get('poolId')) is not type(expected_pool_id)
        or journal.get('poolId') != expected_pool_id
    ):
        raise RuntimeError('pending journal poolId/schemaVersion mismatch')
    validate_bindings_state(
        journal.get('bindingsAfter'), expected_pool_id)
    before = journal.get('before')
    after = journal.get('after')
    if not isinstance(before, dict) or not isinstance(after, dict):
        raise RuntimeError('invalid pending journal state')
    if set(before) != set(after):
        raise RuntimeError('pending journal connection sets differ')
    for connection_id in before:
        if not isinstance(connection_id, str):
            raise RuntimeError('invalid pending journal state')
        for state in (before[connection_id], after[connection_id]):
            if state is not None and not isinstance(state, str):
                raise RuntimeError('invalid pending journal state')
    return journal


def recover_pending_journal(
    db,
    pending_path,
    bindings_path,
    expected_pool_id,
    *,
    mutate=True,
):
    pending_path = pathlib.Path(pending_path)
    if not pending_path.exists():
        return 'none'
    journal = _validated_pending_journal(
        pending_path, expected_pool_id)
    current = {}
    for connection_id in journal['before']:
        row = db.execute(
            'SELECT data FROM providerConnections WHERE id=?',
            (connection_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError('pending connection missing')
        try:
            _data, provider_data = _connection_data(row[0])
        except RuntimeError:
            raise RuntimeError('invalid pending connection data') from None
        current[connection_id] = _current_proxy_pool_id(provider_data)

    if current == journal['after']:
        if mutate:
            write_json_atomic(bindings_path, journal['bindingsAfter'])
            pending_path.unlink()
        return 'committed'
    if current == journal['before']:
        if mutate:
            pending_path.unlink()
        return 'not_committed'
    raise RuntimeError(
        'pending journal does not match an atomic database state'
    )
