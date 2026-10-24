#!/usr/bin/env python3
"""Collect an analysis task's output and attach it to a Discord message."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('report', choices=['alp', 'slowquery'])
    report = parser.parse_args().report
    webhook = os.environ.get('DISCORD_WEBHOOK_URL')
    if not webhook:
        print('DISCORD_WEBHOOK_URL が未設定です。', file=sys.stderr)
        return 1
    root = Path(__file__).resolve().parent.parent
    result = subprocess.run(['task', report], cwd=root, capture_output=True)
    sys.stdout.buffer.write(result.stdout)
    sys.stdout.flush()
    sys.stderr.buffer.write(result.stderr)
    sys.stderr.flush()
    status = '成功' if result.returncode == 0 else '失敗'
    payload = json.dumps({
        'content': f'ISUCON14 {report} 集計: {status}\n対象: s1\n現在のログ全体の集計です。',
        'allowed_mentions': {'parse': []},
    }).encode()
    boundary = uuid.uuid4().hex
    data = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n\r\n'.encode()
        + payload
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="files[0]"; '
          f'filename="{report}.txt"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'.encode()
        + result.stdout + (b'\n' + result.stderr if result.returncode else b'')
        + f'\r\n--{boundary}--\r\n'.encode()
    )
    request = urllib.request.Request(webhook, data=data, headers={
        'Content-Type': f'multipart/form-data; boundary={boundary}',
        'User-Agent': 'isucon14-bench/1.0',
    })
    try:
        with urllib.request.urlopen(request, timeout=20):
            pass
    except Exception:
        # Do not print exceptions that may contain the secret webhook URL.
        print(f'Discord への {report} 投稿に失敗しました。', file=sys.stderr)
        return 1
    print(f'Discord に {report} の集計結果を投稿しました。', flush=True)
    return result.returncode


if __name__ == '__main__':
    sys.exit(main())
