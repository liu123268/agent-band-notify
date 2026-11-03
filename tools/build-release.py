"""Build a Windows x64 portable ZIP using an explicit file allowlist.

Developer tool: Python is used only to build the ZIP, not to run the app.
The official Node archive is pinned and verified before extracting two files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
NODE_VERSION = '24.22.2'
NODE_ARCHIVE = f'node-v{NODE_VERSION}-win-x64.zip'
NODE_URL = f'https://nodejs.org/dist/v{NODE_VERSION}/{NODE_ARCHIVE}'
NODE_SHA256 = 'ca1bff5d8ead13c9f2ea404a176db46bd430704d5b5113734049fa365e7799e2'
LAUNCHERS = ['01-首次配置.cmd', '02-发送测试通知.cmd', '03-开始监听.cmd',
             '04-查看状态.cmd', '05-停止监听.cmd']
APP_FILES = ['notify.js', 'notify.cmd', 'hook-wrapper.cmd', 'start-agent-watch.cmd',
             'config.example.json', 'package.json', 'LICENSE']
TOOL_FILES = ['agent-watch.js', 'quickstart.js', 'setup.js', 'doctor.js',
              'hook-handler.js',
              'codex-watch.js', 'dsh-watch.js']


def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT.parent / 'agent-band-notify-distribution')
    parser.add_argument('--runtime-archive', type=Path, help='Use an already downloaded official archive (SHA256 still checked)')
    args = parser.parse_args()
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise SystemExit('Release output must be outside the source directory.')
    output.mkdir(parents=True, exist_ok=True)
    runtime = args.runtime_archive or output / NODE_ARCHIVE
    if not runtime.exists():
        print('Downloading official Node runtime...', flush=True)
        with urllib.request.urlopen(NODE_URL, timeout=120) as response, runtime.open('wb') as target:
            while block := response.read(1024 * 1024):
                target.write(block)
    if digest(runtime) != NODE_SHA256:
        raise SystemExit('Node archive SHA256 mismatch. Refusing to package.')
    prefix = 'AgentBandNotify-Windows-x64/'
    artifact = output / 'AgentBandNotify-Windows-x64.zip'
    version = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    # No directory-wide archive: each file below is intentionally selected.
    selected = [(ROOT / name, name) for name in LAUNCHERS + ['使用说明.txt', 'README.md', 'LICENSE']]
    selected += [(p, p.relative_to(ROOT).as_posix()) for p in sorted((ROOT / 'docs').glob('*.md'))]
    selected += [(ROOT / name, 'app/' + name) for name in APP_FILES]
    selected += [(ROOT / 'tools' / name, 'app/tools/' + name) for name in TOOL_FILES]
    selected += [(p, 'app/' + p.relative_to(ROOT).as_posix()) for p in sorted((ROOT / 'src').rglob('*.js'))]
    for source, _ in selected:
        if not source.is_file():
            raise SystemExit(f'Missing required release file: {source.name}')
    # Writing a temporary ZIP avoids leaving a corrupt public artifact on failure.
    with tempfile.TemporaryDirectory(prefix='agent-band-build-', dir=output) as work:
        pending = Path(work) / artifact.name
        with zipfile.ZipFile(pending, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as package:
            for source, destination in selected:
                package.write(source, prefix + destination)
            with zipfile.ZipFile(runtime) as official:
                for name in ['node.exe', 'LICENSE']:
                    data = official.read(f'node-v{NODE_VERSION}-win-x64/{name}')
                    package.writestr(prefix + 'app/runtime/' + name, data)
            metadata = f'Agent Band Notify {version}\nNode.js {NODE_VERSION} Windows x64\nSource: {NODE_URL}\nArchive SHA256: {NODE_SHA256}\nLicense: runtime/LICENSE\n'
            package.writestr(prefix + 'app/RUNTIME.txt', metadata.encode('utf-8'))
        pending.replace(artifact)
    checksum = digest(artifact)
    (output / 'SHA256SUMS.txt').write_text(f'{checksum}  {artifact.name}\n', encoding='ascii')
    print(json.dumps({'version': version, 'file': str(artifact), 'bytes': artifact.stat().st_size,
                      'sha256': checksum}, ensure_ascii=False))


if __name__ == '__main__':
    main()
