#!/usr/bin/env python3
"""Stream the remote benchmark and report its result to Discord."""

import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request
import uuid


def notify(result, returncode, logs):
    webhook = os.environ.get('DISCORD_WEBHOOK_URL')
    if not webhook:
        return
    status = '成功' if returncode == 0 and result and 'pass=true' in result else '失敗'
    content = f'ISUCON14 ベンチマーク: {status}\n対象: s1 (172.31.9.253)\n'
    content += result if result else f'結果を取得できませんでした (終了コード: {returncode})'
    data = json.dumps({'content': content[:1900], 'allowed_mentions': {'parse': []}}).encode()
    boundary = uuid.uuid4().hex
    data = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="payload_json"\r\n'
        'Content-Type: application/json\r\n\r\n'.encode() + data
        + f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="files[0]"; '
        'filename="benchmark.log"\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n'.encode()
        + ''.join(logs).encode()
        + f'\r\n--{boundary}--\r\n'.encode()
    )
    request = urllib.request.Request(
        webhook, data=data,
        headers={'Content-Type': f'multipart/form-data; boundary={boundary}',
                 'User-Agent': 'isucon14-bench/1.0'},
    )
    try:
        with urllib.request.urlopen(request, timeout=10):
            pass
        print('Discord にベンチマーク結果を投稿しました。', flush=True)
    except Exception:
        # Exceptions can contain the secret URL; never print their contents.
        print('Discord 通知に失敗しました。', file=sys.stderr)


def main():
    command = (
        'cd /home/isucon && ./bench run '
        '--addr 172.31.9.253:443 '
        '--target https://isuride.xiv.isucon.net '
        '--payment-url http://172.31.5.235:12346 '
        '--payment-bind-port 12346'
    )
    result = None
    logs = []
    process = subprocess.Popen(
        ['ssh', 'bench', command], stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, text=True, errors='replace',
    )
    for line in process.stdout:
        logs.append(line)
        print(line, end='', flush=True)
        if re.search(r'msg=(?:"結果|結果\s)', line):
            result = line[line.index('msg=') + 4:].strip()
    returncode = process.wait()
    notify(result, returncode, logs)
    if os.environ.get('DISCORD_WEBHOOK_URL'):
        for report in ('alp:discord', 'slowquery:discord'):
            try:
                report_result = subprocess.run(
                    ['task', report], cwd=Path(__file__).resolve().parent.parent,
                )
                if report_result.returncode:
                    print(f'{report} に失敗しました。', file=sys.stderr)
            except OSError:
                print(f'{report} を実行できませんでした。', file=sys.stderr)
    return returncode if returncode else (0 if result and 'pass=true' in result else 1)


if __name__ == '__main__':
    sys.exit(main())
