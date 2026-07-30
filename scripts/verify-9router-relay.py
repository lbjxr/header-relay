#!/usr/bin/env python3
import argparse
import http.client
import json
import sqlite3
import sys


DATABASE = '/root/.9router/db/data.sqlite'
HOST = '127.0.0.1'
PORT = 20128
DEFAULT_CODEX_MODEL = 'any/gpt-5.6-sol'
DEFAULT_CLAUDE_MODEL = 'any-claude/claude-fable-5'
INSTRUCTIONS_FILE = '/opt/header-relay/codex-instructions.txt'


def load_api_key(database=DATABASE):
    db = sqlite3.connect(database)
    try:
        row = db.execute(
            "SELECT key FROM apiKeys "
            "WHERE name='openclaw' AND isActive=1 "
            'ORDER BY createdAt, rowid LIMIT 1'
        ).fetchone()
        if row is None:
            row = db.execute(
                'SELECT key FROM apiKeys WHERE isActive=1 '
                'ORDER BY createdAt, rowid LIMIT 1'
            ).fetchone()
        if row is None:
            raise RuntimeError('no active 9router API key found')
        return row[0]
    finally:
        db.close()


def post(
    path,
    payload,
    api_key,
    extra_headers=None,
    host=HOST,
    port=PORT,
):
    connection = http.client.HTTPConnection(host, port, timeout=300)
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
    }
    headers.update(extra_headers or {})
    body = json.dumps(payload, ensure_ascii=False).encode('utf8')
    try:
        connection.request('POST', path, body=body, headers=headers)
        response = connection.getresponse()
        return (
            response.status,
            response.getheader('content-type') or '',
            response.read(),
        )
    finally:
        connection.close()


def sse_events(decoded):
    for line in decoded.splitlines():
        if not line.startswith('data:'):
            continue
        value = line[5:].strip()
        if not value or value == '[DONE]':
            continue
        try:
            event = json.loads(value)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            yield event


def normalize_errors(value):
    if not value:
        return []
    if isinstance(value, list):
        return value
    return [value]


def extract_text(content_type, raw):
    try:
        decoded = raw.decode('utf8')
    except (AttributeError, UnicodeDecodeError):
        return '', [{'type': 'invalid_utf8_response'}]

    if 'text/event-stream' in content_type:
        parts = []
        errors = []
        for event in sse_events(decoded):
            if (
                event.get('type') == 'response.output_text.delta'
                and isinstance(event.get('delta'), str)
            ):
                parts.append(event['delta'])

            choices = event.get('choices') or []
            if isinstance(choices, list) and choices:
                first = choices[0]
                if isinstance(first, dict):
                    delta = first.get('delta') or {}
                    if isinstance(delta, dict):
                        content = delta.get('content')
                        if isinstance(content, str):
                            parts.append(content)

            if event.get('type') == 'content_block_delta':
                delta = event.get('delta') or {}
                if isinstance(delta, dict):
                    text = delta.get('text')
                    if isinstance(text, str):
                        parts.append(text)

            errors.extend(normalize_errors(event.get('error')))
        return ''.join(parts).strip(), errors

    try:
        data = json.loads(decoded)
    except (json.JSONDecodeError, TypeError):
        return '', [{'type': 'non_json_response'}]
    if not isinstance(data, dict):
        return '', [{'type': 'invalid_json_response'}]

    errors = normalize_errors(data.get('error'))
    choices = data.get('choices') or []
    if isinstance(choices, list) and choices:
        first = choices[0]
        if isinstance(first, dict):
            message = first.get('message') or {}
            if isinstance(message, dict):
                content = message.get('content')
                if isinstance(content, str):
                    return content.strip(), errors

    parts = []
    output = data.get('output') or []
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get('content') or []
            if not isinstance(content, list):
                continue
            for part in content:
                if isinstance(part, dict) and isinstance(part.get('text'), str):
                    parts.append(part['text'])

    content = data.get('content') or []
    if isinstance(content, list):
        for part in content:
            if isinstance(part, dict) and isinstance(part.get('text'), str):
                parts.append(part['text'])
    return ''.join(parts).strip(), errors


def _error_types(errors):
    result = []
    for error in errors:
        if isinstance(error, dict):
            result.append(str(
                error.get('type')
                or error.get('code')
                or 'upstream_error'
            ))
        else:
            result.append(type(error).__name__)
    return result


def run_case(
    name,
    path,
    payload,
    api_key,
    model,
    extra_headers=None,
):
    status, content_type, raw = post(
        path, payload, api_key, extra_headers
    )
    extracted_text, errors = extract_text(content_type, raw)
    succeeded = (
        200 <= status < 300
        and 'OK' in extracted_text.upper()
        and not errors
    )
    print(json.dumps({
        'case': name,
        'model': model,
        'status': status,
        'text': extracted_text[:200] if succeeded else '',
        'responseBytes': len(raw),
        'errorCount': len(errors),
        'errorTypes': _error_types(errors),
    }, ensure_ascii=False))
    return succeeded


def main(argv=None):
    parser = argparse.ArgumentParser(
        description='Verify 9router through header-relay profiles.'
    )
    parser.add_argument('--codex-model', default=DEFAULT_CODEX_MODEL)
    parser.add_argument('--claude-model', default=DEFAULT_CLAUDE_MODEL)
    parser.add_argument('--database', default=DATABASE)
    args = parser.parse_args(argv)

    api_key = load_api_key(args.database)
    with open(INSTRUCTIONS_FILE, encoding='utf8') as handle:
        codex_instructions = handle.read()

    chat_ok = run_case(
        'chat_gpt_5_6_sol',
        '/v1/chat/completions',
        {
            'model': args.codex_model,
            'messages': [{'role': 'user', 'content': '只回复 OK'}],
            'stream': True,
        },
        api_key,
        args.codex_model,
    )

    session_id = 'header-relay-native-verification'
    responses_ok = run_case(
        'native_responses_gpt_5_6_sol',
        '/v1/responses',
        {
            'model': args.codex_model,
            'instructions': codex_instructions,
            'input': [
                {
                    'type': 'additional_tools',
                    'role': 'developer',
                    'tools': [{
                        'type': 'custom',
                        'name': 'noop',
                        'description': (
                            'A no-op verification tool that must not be called.'
                        ),
                    }],
                },
                {
                    'type': 'message',
                    'role': 'user',
                    'content': [{
                        'type': 'input_text',
                        'text': '只回复 OK',
                    }],
                },
            ],
            'client_metadata': {
                'client_name': 'codex_cli_rs',
                'client_version': '0.136.0',
            },
            'stream': True,
            'store': False,
            'tool_choice': 'auto',
            'reasoning': {'effort': 'low', 'summary': 'auto'},
            'include': ['reasoning.encrypted_content'],
            'prompt_cache_key': session_id,
            'text': {'verbosity': 'low'},
        },
        api_key,
        args.codex_model,
        {
            'Accept': 'text/event-stream',
            'User-Agent': 'codex_cli_rs/0.136.0',
            'originator': 'codex_cli_rs',
            'session_id': session_id,
        },
    )

    claude_ok = run_case(
        'claude_messages_1m',
        '/v1/messages',
        {
            'model': args.claude_model,
            'max_tokens': 16,
            'messages': [{'role': 'user', 'content': '只回复 OK'}],
            'stream': True,
        },
        api_key,
        args.claude_model,
        {
            'Accept': 'text/event-stream',
            'Anthropic-Version': '2023-06-01',
        },
    )
    return 0 if chat_ok and responses_ok and claude_ok else 1


if __name__ == '__main__':
    sys.exit(main())
