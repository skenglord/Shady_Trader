"""Read one Freqtrade result from its archive without extracting files."""
import json
import sys
from zipfile import ZipFile

with ZipFile(sys.argv[1]) as archive:
    entries = [entry for entry in archive.infolist()
               if entry.filename.startswith("backtest-result-") and entry.filename.endswith(".json")
               and not entry.filename.endswith(("_config.json", ".meta.json"))]
    if len(entries) != 1 or entries[0].file_size > 64 * 1024 * 1024:
        raise ValueError("Expected one bounded backtest result in the archive")
    print(json.dumps(json.loads(archive.read(entries[0]))))
