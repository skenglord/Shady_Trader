#!/usr/bin/env python3
"""
Smoke test for freqtrade webserver.
Asserts that the /api/v1/ping endpoint returns 'pong'.
"""
import sys
import urllib.request
import urllib.error
import json

def main():
    host = "127.0.0.1"
    port = 8081  # default, can be overridden by env
    url = f"http://{host}:{port}/api/v1/ping"
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            if resp.status != 200:
                print(f"ERROR: Expected HTTP 200, got {resp.status}")
                sys.exit(1)
            data = resp.read().decode('utf-8')
            # Expecting just the string 'pong' (no quotes) or maybe a JSON?
            # freqtrade webserver returns plain text 'pong'
            if data.strip() == 'pong':
                print("SUCCESS: /api/v1/ping returned 'pong'")
                sys.exit(0)
            else:
                print(f"ERROR: Unexpected response: {data!r}")
                sys.exit(1)
    except urllib.error.URLError as e:
        print(f"ERROR: Cannot connect to {url}: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()