"""Build an embedding bundle from the existing dashboard, without changing it.

Only the explicit ?embed=dufesh document permits the production main origin.
Standalone documents, APIs, cookies and CSRF rules retain their protections.
"""
import argparse
import shutil
from pathlib import Path


def replace_once(value, before, after):
    if value.count(before) != 1:
        raise ValueError("Upstream source changed; review the runtime status patch")
    return value.replace(before, after, 1)


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
    dashboard = replace_once(dashboard,
        'from dashboard_state import public_actions, public_status',
        'from dashboard_state import public_actions\nfrom runtime_status import public_status, public_events')
    dashboard = replace_once(dashboard,
        '"phase", "authentication_state", "last_auth_accepted_at", "last_poll_completed_at",',
        '"phase", "authentication_state", "last_auth_accepted_at", "last_auth_rejected_at", "session_renewal", "last_poll_completed_at",')
    dashboard = replace_once(dashboard, '        return result\n\n\n@dataclass',
        '''        try:
            path = self.status_path.with_name("runtime-events.json")
            history = json.loads(path.read_text(encoding="utf-8")) if path.stat().st_size <= 256 * 1024 else []
            history = public_events(history)
        except (OSError, ValueError):
            history = []
        actions = [{"kind": "attendance", "at": item["updated_at"], **item} for item in result["recent_actions"]]
        result["runtime_events"] = public_events([*history, *actions])
        return result


@dataclass''')
    html = (source / "web/index.html").read_text(encoding="utf-8")
    if html.count('  <script src="/app.js" defer></script>') != 1:
        raise ValueError("Dashboard HTML changed; review the embedding patch")
    html = html.replace('  <script src="/app.js" defer></script>',
                        '  <link rel="stylesheet" href="/dufesh-embed.css">\n'
                        '  <script src="/dufesh-embed.js" defer></script>\n'
                        '  <script src="/app.js" defer></script>')
    html = replace_once(html, '      <div id="page-error"',
        (Path(__file__).parent / "runtime-panel.html").read_text(encoding="utf-8") + '\n      <div id="page-error"')
    app_js = (source / "web/app.js").read_text(encoding="utf-8")
    scale = "const pixelsPerMinute = 44 / 60;"
    if app_js.count(scale) != 1:
        raise ValueError("Dashboard timeline changed; review the compact scale")
    app_js = app_js.replace(scale,
                            'const pixelsPerMinute = (new URLSearchParams(location.search).get("embed") === "dufesh" ? 28 : 44) / 60;', 1)
    app_js = replace_once(app_js, '    renderStatus();', '    renderStatus();\n    renderRuntime();')
    app_js = replace_once(app_js, '  function disabledDates()',
        (Path(__file__).parent / "runtime-panel.js").read_text(encoding="utf-8") + '\n  function disabledDates()')
    diagnostics = (source / "diagnostics.py").read_text(encoding="utf-8")
    diagnostics = replace_once(diagnostics, 'from dashboard_state import public_actions, public_attendance, public_status',
        'from dashboard_state import public_actions, public_attendance\nfrom runtime_status import publish_health')
    diagnostics = replace_once(diagnostics, 'shared_write(Path(target), public_status(scrub(state, self.secrets)))',
        'publish_health(Path(target), scrub(state, self.secrets), shared_write)')
    destination.mkdir(parents=True)
    (destination / "web").mkdir()
    (destination / "dashboard.py").write_text(dashboard, encoding="utf-8", newline="\n")
    (destination / "diagnostics.py").write_text(diagnostics, encoding="utf-8", newline="\n")
    shutil.copyfile(Path(__file__).parent / "runtime_status.py", destination / "runtime_status.py")
    (destination / "web/index.html").write_text(html, encoding="utf-8", newline="\n")
    (destination / "web/app.js").write_text(app_js, encoding="utf-8", newline="\n")
    shutil.copyfile(source / "web/style.css", destination / "web/style.css")
    for name in ("dufesh-embed.js", "dufesh-embed.css"):
        shutil.copyfile(Path(__file__).parent / name, destination / "web" / name)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    prepare(args.source.resolve(), args.destination.resolve())
