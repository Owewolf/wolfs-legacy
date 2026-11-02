#!/usr/bin/env python3
"""Optional system WebKitGTK runner, orchestrated by test-mobile-browsers.js.

Requires the host's PyGObject, GTK 3 and WebKit2 4.1 bindings. No vault server,
database, credentials, or mobile device are accessed.
"""
import hashlib
import json
import os
from pathlib import Path
import sys
import time
import warnings

os.environ.setdefault("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
warnings.filterwarnings("ignore", category=DeprecationWarning)
import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2


def wait_until(predicate, label, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        while GLib.MainContext.default().pending():
            GLib.MainContext.default().iteration(False)
        result = predicate()
        if result:
            return result
        time.sleep(0.01)
    raise RuntimeError("Timed out: " + label)


def main():
    config = json.loads(Path(sys.argv[1]).read_text())
    output = Path(config["output"])
    output.mkdir(parents=True, exist_ok=True)
    window = Gtk.OffscreenWindow()
    view = WebKit2.WebView()
    theme_script = WebKit2.UserScript.new("localStorage.setItem('lv_theme'," + json.dumps(config.get("theme", "dark")) + ");", WebKit2.UserContentInjectedFrames.TOP_FRAME, WebKit2.UserScriptInjectionTime.START, None, None)
    view.get_user_content_manager().add_script(theme_script)
    view.get_settings().set_enable_webgl(False)
    window.add(view)
    window.show_all()
    loaded = {"done": False}

    def changed(_view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            loaded["done"] = True

    view.connect("load-changed", changed)

    def evaluate(script):
        result = {}

        def finished(source, async_result, _data):
            try:
                result["value"] = source.run_javascript_finish(async_result).get_js_value().to_string()
            except Exception as error:
                result["error"] = error

        view.run_javascript(script, None, finished, None)
        wait_until(lambda: "value" in result or "error" in result, "JavaScript result")
        if "error" in result:
            raise result["error"]
        return result["value"]

    def load(screen, route, ready):
        loaded["done"] = False
        view.load_uri(config["origin"] + "/?screen=" + screen + route)
        wait_until(lambda: loaded["done"], "load " + screen)
        if screen in ("recipient", "recording"):
            evaluate("window.renderMobileRecipient(); 'started'")
            wait_until(lambda: evaluate("Boolean(document.querySelector('[data-recipient-content]'))") == "true", "recipient content")
            if screen == "recording":
                evaluate("document.querySelector('[data-recipient-content]').click(); 'opened'")
                wait_until(lambda: evaluate("Boolean(document.querySelector('[data-legacy-file][data-mode=preview]'))") == "true", "recording attachment")
                evaluate("document.querySelector('[data-legacy-file][data-mode=preview]').click(); 'opened'")
        wait_until(lambda: evaluate("Boolean(document.querySelector(" + json.dumps(ready) + "))") == "true", "render " + screen)
        evaluate("document.documentElement.style.scrollBehavior='auto'; 'ready'")
        # Pump a short interval so pending layout and async fixture work settles.
        settled = time.monotonic() + 0.15
        wait_until(lambda: time.monotonic() >= settled, "settled layout")

    def snapshot(destination):
        state = {}

        def finished(source, result, _data):
            try:
                source.get_snapshot_finish(result).write_to_png(str(destination))
                state["done"] = True
            except Exception as error:
                state["error"] = error

        view.get_snapshot(WebKit2.SnapshotRegion.FULL_DOCUMENT, WebKit2.SnapshotOptions.NONE, None, finished, None)
        wait_until(lambda: state, "snapshot")
        if "error" in state:
            raise state["error"]

    version = ".".join(str(method()) for method in (WebKit2.get_major_version, WebKit2.get_minor_version, WebKit2.get_micro_version))
    report = {"phase": config["phase"], "synthetic_data_only": True, "engines": [{"name": "system-webkit", "version": version}], "screens": []}
    try:
        for width in config["widths"]:
            height = config.get("height") or (1100 if width >= 768 else 844)
            view.set_size_request(width, height)
            window.resize(width, height)
            for name, route, ready in config["screens"]:
                load(name, route, ready)
                metrics = json.loads(evaluate("""JSON.stringify({
                    width:innerWidth,height:innerHeight,document_width:document.documentElement.scrollWidth,
                    overflow:document.documentElement.scrollWidth>innerWidth+1,
                    undersized_text_inputs:[...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=hidden]),select,textarea')].filter(el=>el.getBoundingClientRect().height&&!el.closest('[inert]')).filter(el=>parseFloat(getComputedStyle(el).fontSize)<16).map(el=>el.id||el.name)
                })"""))
                assert metrics["width"] == width, f"Expected {width}px viewport, got {metrics['width']}"
                filename = f"system-webkit-{name}-{width}.png"
                snapshot(output / filename)
                row = {"engine": "system-webkit", "screen": name, **metrics, "screenshot": filename}
                if config["phase"] != "baseline" and width <= 1024:
                    assert not metrics["overflow"], f"{name} at {width}px has document overflow: {metrics}"
                    assert not metrics["undersized_text_inputs"], f"{name} at {width}px has small text inputs: {metrics}"
                if config.get("reference") and width > 1024:
                    row["desktop_identical"] = hashlib.sha256((output / filename).read_bytes()).digest() == hashlib.sha256((Path(config["reference"]) / filename).read_bytes()).digest()
                    assert row["desktop_identical"], f"WebKit desktop changed: {name} {width}px"
                report["screens"].append(row)
                print(f"{config['phase']} system-webkit {name} {width}px: {'overflow' if metrics['overflow'] else 'fits'}", flush=True)
            if config["phase"] != "baseline" and width in (390, 820):
                load("workflow", "#vault", ".vault-grid")
                evaluate("window.__mobileResult=null; (" + config["workflow"] + ")().then(checks=>window.__mobileResult={ok:true,checks}).catch(error=>window.__mobileResult={ok:false,error:error.message,stack:error.stack}); 'started'")
                result = json.loads(wait_until(lambda: evaluate("window.__mobileResult ? JSON.stringify(window.__mobileResult) : ''"), "mobile workflows", 40))
                assert result["ok"], result
                report["screens"].append({"engine": "system-webkit", "screen": "workflows", "width": width, "checks": result["checks"]})
                print(f"after system-webkit workflows {width}px: {len(result['checks'])} checks passed", flush=True)
        (output / "system-webkit-report.json").write_text(json.dumps(report, indent=2) + "\n")
    finally:
        window.destroy()


if __name__ == "__main__":
    main()
