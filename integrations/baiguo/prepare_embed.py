"""Build an embedding bundle from the existing dashboard, without changing it.

Only the explicit ?embed=dufesh document permits the production main origin.
Standalone documents, APIs, cookies and CSRF rules retain their protections.
"""
import argparse
import shutil
from pathlib import Path


def prepare(source: Path, destination: Path):
    if destination.exists():
        raise ValueError("Choose a new output directory")
    dashboard = (source / "dashboard.py").read_text(encoding="utf-8")
    old = '''        self.send_header("X-Frame-Options", "DENY")'''
    new = '''        parsed = urlsplit(self.path)
        embedded = (parsed.path in {"/", "/index.html"}
                    and parse_qs(parsed.query).get("embed") == ["dufesh"])
        if not embedded:
            self.send_header("X-Frame-Options", "DENY")'''
    patches = [
        (old, new),
        ('''frame-ancestors 'none'; base-uri 'none'; form-action 'self'")''',
         '''frame-ancestors " + ("https://dufesh.cn" if embedded else "'none'") + "; base-uri 'none'; form-action 'self'")'''),
        ('"/app.js", "/style.css"}', '"/app.js", "/style.css", "/dufesh-embed.js", "/dufesh-embed.css"}'),
        ('"style.css": "text/css; charset=utf-8"}', '"style.css": "text/css; charset=utf-8", "dufesh-embed.js": "application/javascript; charset=utf-8", "dufesh-embed.css": "text/css; charset=utf-8"}'),
    ]
    for before, after in patches:
        if dashboard.count(before) != 1:
            raise ValueError("Dashboard source changed; review the embedding patch")
        dashboard = dashboard.replace(before, after, 1)
    html = (source / "web/index.html").read_text(encoding="utf-8")
    if html.count('  <script src="/app.js" defer></script>') != 1:
        raise ValueError("Dashboard HTML changed; review the embedding patch")
    html = html.replace('  <script src="/app.js" defer></script>',
                        '  <link rel="stylesheet" href="/dufesh-embed.css">\n'
                        '  <script src="/dufesh-embed.js" defer></script>\n'
                        '  <script src="/app.js" defer></script>')
    destination.mkdir(parents=True)
    (destination / "web").mkdir()
    (destination / "dashboard.py").write_text(dashboard, encoding="utf-8", newline="\n")
    (destination / "web/index.html").write_text(html, encoding="utf-8", newline="\n")
    for name in ("app.js", "style.css"):
        shutil.copyfile(source / "web" / name, destination / "web" / name)
    for name in ("dufesh-embed.js", "dufesh-embed.css"):
        shutil.copyfile(Path(__file__).parent / name, destination / "web" / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    prepare(args.source.resolve(), args.destination.resolve())
