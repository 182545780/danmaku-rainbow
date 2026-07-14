import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

test("web build contains the control panel bundle", () => {
  assert.equal(existsSync("dist-web/index.html"), true);
  const html = readFileSync("dist-web/index.html", "utf8");
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /src="\/assets\//);
});

test("local server is restricted to loopback and exposes the OBS route", () => {
  const source = readFileSync("electron/main.mjs", "utf8");
  assert.match(source, /const HOST = "127\.0\.0\.1"/);
  assert.match(source, /pathname === "\/overlay"/);
  assert.match(source, /\/api\/settings/);
  assert.match(source, /\/events/);
});

test("Bilibili WBI and websocket protocol support are present", () => {
  const source = readFileSync("electron/main.mjs", "utf8");
  assert.match(source, /w_rid/);
  assert.match(source, /getDanmuInfo/);
  assert.match(source, /WS_OP\.USER_AUTHENTICATION/);
  assert.match(source, /DANMU_MSG/);
  assert.match(source, /SUPER_CHAT_MESSAGE/);
});
