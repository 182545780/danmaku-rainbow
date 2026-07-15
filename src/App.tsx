import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type ColorMode = "rainbow" | "source" | "white";

type Settings = {
  roomId: string;
  speed: number;
  fontSize: number;
  opacity: number;
  panelWidth: number;
  panelSide: "left" | "right";
  colorMode: ColorMode;
  showNames: boolean;
  showShadow: boolean;
  showGifts: boolean;
  keywords: string;
};

type Status = {
  state: "idle" | "connecting" | "connected" | "reconnecting" | "error";
  message: string;
  roomId?: number;
  online?: number;
};

type AuthState = {
  loggedIn: boolean;
  uid: number;
  userName: string;
};

type Danmaku = {
  id: string;
  kind: "danmu" | "superchat" | "gift" | "test";
  user: string;
  content: string;
  sourceColor?: string;
  price?: number;
  guardLevel?: number;
};

const defaults: Settings = {
  roomId: "",
  speed: 14,
  fontSize: 28,
  opacity: 94,
  panelWidth: 440,
  panelSide: "right",
  colorMode: "rainbow",
  showNames: true,
  showShadow: true,
  showGifts: true,
  keywords: "",
};

const brightNameColors = [
  "#ff5c8a",
  "#ff8a3d",
  "#42d37b",
  "#4da3ff",
  "#9b7bff",
  "#19c6c8",
  "#ff6b5f",
  "#e760ff",
];

function formatOnline(value?: number) {
  if (!value) return "—";
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  return new Intl.NumberFormat("zh-CN").format(value);
}

function useServerEvents(onMessage?: (message: Danmaku) => void) {
  const [status, setStatus] = useState<Status>({ state: "idle", message: "等待连接" });
  const [settings, setSettings] = useState<Settings>(defaults);
  const [auth, setAuth] = useState<AuthState>({ loggedIn: false, uid: 0, userName: "" });
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    fetch("/api/settings")
      .then((response) => response.json())
      .then((data) => setSettings({ ...defaults, ...data }))
      .catch(() => undefined);
    fetch("/api/auth")
      .then((response) => response.json())
      .then(setAuth)
      .catch(() => undefined);

    const events = new EventSource("/events");
    events.addEventListener("settings", (event) => {
      setSettings({ ...defaults, ...JSON.parse((event as MessageEvent).data) });
    });
    events.addEventListener("status", (event) => {
      setStatus(JSON.parse((event as MessageEvent).data));
    });
    events.addEventListener("auth", (event) => {
      setAuth(JSON.parse((event as MessageEvent).data));
    });
    for (const type of ["danmu", "superchat", "gift", "test"]) {
      events.addEventListener(type, (event) => {
        handlerRef.current?.(JSON.parse((event as MessageEvent).data));
      });
    }
    return () => events.close();
  }, []);

  return { status, settings, setSettings, auth };
}

function Overlay() {
  const [messages, setMessages] = useState<Array<Danmaku & { duration: number; nameColor: string }>>([]);
  const settingsRef = useRef(defaults);

  const addMessage = useCallback((message: Danmaku) => {
    const settings = settingsRef.current;
    if (message.kind === "gift" && !settings.showGifts) return;
    const blocked = settings.keywords
      .split(/[\n,，]/)
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    if (blocked.some((word) => `${message.user} ${message.content}`.toLowerCase().includes(word))) return;

    const duration = Math.max(8, settings.speed + Math.min(message.content.length * 0.05, 3));
    const nameColor = brightNameColors[Math.floor(Math.random() * brightNameColors.length)];
    const item = { ...message, duration, nameColor };
    setMessages((current) => [...current.slice(-39), item]);
    window.setTimeout(() => {
      setMessages((current) => current.filter((entry) => entry.id !== item.id));
    }, (duration + 2) * 1000);
  }, []);

  const { settings } = useServerEvents(addMessage);
  settingsRef.current = settings;

  return (
    <main className={`overlay overlay--${settings.panelSide}`} aria-label="直播弹幕透明输出层">
      <section className="chat-rail" style={{ "--panel-width": `${settings.panelWidth}px` } as React.CSSProperties}>
        <div className="chat-rail__glow" aria-hidden="true" />
        <div className="chat-list">
          {messages.map((message) => (
            <article
              className={`danmaku danmaku--${message.kind} ${settings.showShadow ? "has-shadow" : ""}`}
              key={message.id}
              style={{
                "--duration": `${message.duration}s`,
                "--name-color": message.nameColor,
                "--font-size": `${settings.fontSize}px`,
                "--opacity": settings.opacity / 100,
              } as React.CSSProperties}
            >
              <span className="danmaku__body">
                {message.kind === "superchat" && <span className="danmaku__badge">SC ¥{message.price}</span>}
                {message.kind === "gift" && <span className="danmaku__badge">礼物</span>}
                {settings.showNames && <span className="danmaku__name">{message.user || "匿名观众"}: </span>}
                <span className="danmaku__content">{message.content}</span>
              </span>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

function RangeControl({ label, value, min, max, step = 1, suffix, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range-control">
      <span>{label}</span>
      <output>{value}{suffix}</output>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  );
}

function Toggle({ checked, label, note, onChange }: { checked: boolean; label: string; note: string; onChange: (value: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span><strong>{label}</strong><small>{note}</small></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function ControlPanel() {
  const [received, setReceived] = useState(0);
  const [copied, setCopied] = useState(false);
  const { status, settings, setSettings, auth } = useServerEvents(() => setReceived((value) => value + 1));
  const saveTimer = useRef<number | undefined>(undefined);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        }).catch(() => undefined);
      }, 220);
      return next;
    });
  }, [setSettings]);

  const overlayUrl = `${window.location.origin}/overlay`;
  const connected = status.state === "connected";
  const statusLabel = {
    idle: "尚未连接",
    connecting: "正在连接",
    connected: "弹幕已连接",
    reconnecting: "正在重连",
    error: "连接异常",
  }[status.state];

  const copyUrl = async () => {
    await navigator.clipboard.writeText(overlayUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="traffic-lights" aria-hidden="true"><i /><i /><i /></div>
        <div className="brand-mark">幕</div>
        <div className="brand-copy">
          <h1>彩虹弹幕机</h1>
          <p>BILIBILI LIVE × OBS</p>
        </div>
        <div className={`status-pill status-pill--${status.state}`}><i />{statusLabel}</div>
      </header>

      <div className="workspace">
        <section className="preview-column">
          <div className="section-heading">
            <div><span>LIVE PREVIEW</span><h2>透明画布预览</h2></div>
            <div className="live-chip"><i />{connected ? `房间 ${status.roomId || settings.roomId}` : "OFFLINE"}</div>
          </div>
          <div className="preview-frame">
            <iframe src="/overlay?preview=1" title="OBS 弹幕输出预览" />
            {!settings.roomId && (
              <div className="preview-empty">
                <div className="empty-orbit"><span>幕</span></div>
                <h3>输入直播间号，弹幕即刻起飞</h3>
                <p>这里与 OBS 浏览器源看到的画面完全一致</p>
              </div>
            )}
            <div className="safe-area"><span>OBS SAFE AREA</span></div>
          </div>
          <div className="metric-row">
            <div><span>连接状态</span><strong>{status.message}</strong></div>
            <div><span>当前人气</span><strong>{formatOnline(status.online)}</strong></div>
            <div><span>本次接收</span><strong>{received}</strong></div>
          </div>

          <div className="obs-card">
            <div className="obs-icon">OBS</div>
            <div><span>浏览器源地址</span><code>{overlayUrl}</code></div>
            <button onClick={copyUrl}>{copied ? "已复制" : "复制地址"}</button>
          </div>
          <p className="obs-note">OBS 新建“浏览器”来源，宽高建议 1920 × 1080，并勾选“场景激活时刷新浏览器”。</p>
        </section>

        <aside className="control-column">
          <section className="panel room-panel">
            <div className="panel-title"><span>01</span><div><h2>直播间</h2><p>支持短号与完整房间号</p></div></div>
            <label className="room-input">
              <span>live.bilibili.com/</span>
              <input inputMode="numeric" pattern="[0-9]*" placeholder="输入房间号" value={settings.roomId} onChange={(event) => update({ roomId: event.target.value.replace(/\D/g, "") })} />
            </label>
            <button className="primary-button" onClick={() => fetch("/api/reconnect", { method: "POST" })} disabled={!settings.roomId}>
              <i />{connected ? "重新连接" : "连接弹幕"}
            </button>
            <div className={`bili-auth bili-auth--${auth.loggedIn ? "active" : "guest"}`}>
              <div>
                <strong>{auth.loggedIn ? (auth.userName || `UID ${auth.uid}`) : "游客模式"}</strong>
                <small>{auth.loggedIn ? "显示完整用户名 · 登录状态自动保存" : "昵称显示为首字 + **"}</small>
              </div>
              <button onClick={() => fetch(auth.loggedIn ? "/api/auth/logout" : "/api/auth/login", { method: "POST" })}>
                {auth.loggedIn ? "退出登录" : "二维码登录"}
              </button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title"><span>02</span><div><h2>动效</h2><p>调整弹幕节奏与画面密度</p></div></div>
            <RangeControl label="停留时间" value={settings.speed} min={8} max={30} suffix="秒" onChange={(speed) => update({ speed })} />
            <RangeControl label="文字大小" value={settings.fontSize} min={20} max={44} suffix="px" onChange={(fontSize) => update({ fontSize })} />
            <RangeControl label="不透明度" value={settings.opacity} min={40} max={100} suffix="%" onChange={(opacity) => update({ opacity })} />
            <RangeControl label="侧栏宽度" value={settings.panelWidth} min={320} max={620} step={10} suffix="px" onChange={(panelWidth) => update({ panelWidth })} />
            <div className="side-picker" role="group" aria-label="侧栏位置">
              <span>侧栏位置</span>
              <button className={settings.panelSide === "left" ? "active" : ""} onClick={() => update({ panelSide: "left" })}>左侧</button>
              <button className={settings.panelSide === "right" ? "active" : ""} onClick={() => update({ panelSide: "right" })}>右侧</button>
            </div>
          </section>

          <section className="panel">
            <div className="panel-title"><span>03</span><div><h2>配色</h2><p>每条用户名随机使用一种高亮纯色</p></div></div>
            <div className="name-color-preview" aria-label="随机用户名颜色预览">
              {brightNameColors.map((color) => <i key={color} style={{ backgroundColor: color }} />)}
            </div>
          </section>

          <section className="panel compact-panel">
            <div className="panel-title"><span>04</span><div><h2>显示内容</h2><p>控制 OBS 画面元素</p></div></div>
            <Toggle checked={settings.showNames} label="观众昵称" note={auth.loggedIn ? "已登录：完整用户名" : "游客：首字 + **"} onChange={(showNames) => update({ showNames })} />
            <Toggle checked={settings.showShadow} label="文字阴影" note="复杂画面更清晰" onChange={(showShadow) => update({ showShadow })} />
            <Toggle checked={settings.showGifts} label="礼物与醒目留言" note="包含 SC 与礼物提示" onChange={(showGifts) => update({ showGifts })} />
          </section>

          <section className="panel compact-panel">
            <div className="panel-title"><span>05</span><div><h2>屏蔽词</h2><p>逗号或换行分隔</p></div></div>
            <textarea placeholder="广告, 刷屏词, 不想看到的内容" value={settings.keywords} onChange={(event) => update({ keywords: event.target.value })} />
            <button className="test-button" onClick={() => fetch("/api/test", { method: "POST" })}>发送一条测试弹幕</button>
          </section>
        </aside>
      </div>
    </main>
  );
}

export function App() {
  const isOverlay = useMemo(() => window.location.pathname === "/overlay", []);
  return isOverlay ? <Overlay /> : <ControlPanel />;
}
