import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { isMaskedUserName, visibleUserName } from "../electron/bilibili-user.mjs";

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

test("overlay keeps complete usernames visible", () => {
  const styles = readFileSync("src/styles.css", "utf8");
  const nameRule = styles.match(/\.danmaku__name\s*\{([^}]*)\}/)?.[1] || "";

  assert.match(styles, /\.danmaku\s*\{[^}]*flex:\s*0 0 auto;/s);
  assert.match(nameRule, /white-space:\s*normal/);
  assert.match(nameRule, /overflow-wrap:\s*anywhere/);
  assert.doesNotMatch(nameRule, /ellipsis|nowrap/);
});

test("masked Bilibili usernames are resolved or replaced with a full UID", () => {
  const source = readFileSync("electron/main.mjs", "utf8");

  assert.equal(isMaskedUserName("云***"), true);
  assert.equal(isMaskedUserName("完整用户名"), false);
  assert.equal(visibleUserName("云***", 123456), "用户123456");
  assert.equal(visibleUserName("完整用户名", 123456), "完整用户名");
  assert.match(source, /x\/frontend\/finger\/spi/);
  assert.match(source, /x\/web-interface\/card\?mid=/);
  assert.match(source, /userNameCache/);
});
