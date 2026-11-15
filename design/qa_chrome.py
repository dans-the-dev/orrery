"""Render and measure Orrery pages through headless Chrome DevTools Protocol."""
import base64
import json
import os
import shutil
import socket
import struct
import subprocess
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.resolve()
PROFILE = ROOT / '.chrome-qa-profile'


class ChromeSocket:
    def __init__(self, url):
        from urllib.parse import urlparse
        parsed = urlparse(url)
        self.socket = socket.create_connection((parsed.hostname, parsed.port), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        request = (f'GET {parsed.path} HTTP/1.1\r\nHost: {parsed.hostname}:{parsed.port}\r\n'
                   f'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                   'Sec-WebSocket-Version: 13\r\n\r\n')
        self.socket.sendall(request.encode())
        header = b''
        while b'\r\n\r\n' not in header:
            header += self.socket.recv(4096)
        if b'HTTP/1.1 101 ' not in header:
            raise RuntimeError(header.decode(errors='replace'))
        self.rest = header.split(b'\r\n\r\n', 1)[1]
        self.counter = 0

    def read_exact(self, n):
        while len(self.rest) < n:
            self.rest += self.socket.recv(65536)
        data, self.rest = self.rest[:n], self.rest[n:]
        return data

    def receive(self):
        first, second = self.read_exact(2)
        size = second & 127
        if size == 126:
            size = struct.unpack('!H', self.read_exact(2))[0]
        elif size == 127:
            size = struct.unpack('!Q', self.read_exact(8))[0]
        if second & 128:
            mask = self.read_exact(4)
            data = self.read_exact(size)
            data = bytes(value ^ mask[i % 4] for i, value in enumerate(data))
        else:
            data = self.read_exact(size)
        if first & 15 == 8:
            raise RuntimeError('Chrome closed the socket')
        return json.loads(data)

    def send(self, method, params=None):
        self.counter += 1
        payload = json.dumps({'id': self.counter, 'method': method, 'params': params or {}}).encode()
        size = len(payload)
        prefix = bytes([0x81, 0x80 | size]) if size < 126 else bytes([0x81, 0xfe]) + struct.pack('!H', size)
        mask = os.urandom(4)
        self.socket.sendall(prefix + mask + bytes(value ^ mask[i % 4] for i, value in enumerate(payload)))
        while True:
            message = self.receive()
            if message.get('id') == self.counter:
                if 'error' in message:
                    raise RuntimeError(message['error'])
                return message.get('result', {})

    def close(self):
        self.socket.close()


def main():
    if PROFILE.exists():
        shutil.rmtree(PROFILE)
    process = subprocess.Popen(['/usr/bin/google-chrome', '--headless=new', '--no-sandbox',
                                '--disable-gpu', '--no-first-run', '--no-default-browser-check',
                                '--remote-allow-origins=*', '--remote-debugging-port=0',
                                f'--user-data-dir={PROFILE}', 'about:blank'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        active = PROFILE / 'DevToolsActivePort'
        for _ in range(100):
            if active.exists():
                break
            time.sleep(.1)
        port = int(active.read_text().splitlines()[0])
        target = next(item for item in json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}/json').read()) if item['type'] == 'page')
        ws = ChromeSocket(target['webSocketDebuggerUrl'])
        ws.send('Page.enable')
        for folder in sorted((ROOT / 'directions').iterdir()):
            if not folder.is_dir():
                continue
            for page in ('index.html', 'app.html', 'signer.html'):
                for width, height in ((1440, 1000), (390, 1180)):
                    ws.send('Emulation.setDeviceMetricsOverride', {'width':width,'height':height,
                            'deviceScaleFactor':1,'mobile':width==390})
                    ws.send('Page.navigate', {'url':(folder / page).as_uri()})
                    time.sleep(.6)
                    result = ws.send('Runtime.evaluate', {'expression':
                        '({viewport:innerWidth,scroll:document.documentElement.scrollWidth,'
                        'body:document.body.scrollWidth,height:document.documentElement.scrollHeight})',
                        'returnByValue':True})['result']['value']
                    print(f'{folder.name}/{page} {width}: {result}', flush=True)
                    if page == 'index.html' or os.getenv('QA_EXTRA') == '1':
                        filename = 'preview.png' if width == 1440 else 'mobile.png'
                        shot = ws.send('Page.captureScreenshot', {'format':'png','captureBeyondViewport':False})
                        destination = folder / filename if page == 'index.html' else ROOT / f'.qa-{folder.name}-{page}-{width}.png'
                        destination.write_bytes(base64.b64decode(shot['data']))
        ws.close()
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
        shutil.rmtree(PROFILE, ignore_errors=True)


if __name__ == '__main__':
    main()
