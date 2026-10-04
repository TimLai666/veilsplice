"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Settings = { ok: boolean; configured?: boolean; csrf?: string; message?: string };
async function loadSettings(): Promise<Settings> {
  try {
    const response = await fetch("/api/finmind/credential", { cache: "no-store", credentials: "same-origin", mode: "same-origin", redirect: "error" });
    return await response.json() as Settings;
  } catch { return { ok: false, message: "無法載入設定，請稍後重新整理。" }; }
}
export default function CredentialSettings({ onChange }: { onChange: () => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [confirmDisable, setConfirmDisable] = useState(false);
  const load = useCallback(async () => { setSettings(await loadSettings()); }, []);
  useEffect(() => { let active = true; void loadSettings().then(data => { if (active) setSettings(data); }); return () => { active = false; }; }, []);
  const submit = async (method: "POST" | "DELETE") => {
    if (busy || !settings?.ok || !settings.csrf) return;
    setBusy(true); setNotice("");
    let submitted = false;
    try {
      // Refresh the short-lived CSRF token before sending any credential, so
      // idle tabs and a later expiry do not normally force key re-entry.
      const current = await loadSettings();
      if (!current.ok || !current.csrf) { setNotice(current.message ?? "無法確認表單狀態，尚未提交金鑰。"); return; }
      submitted = true;
      const response = await fetch("/api/finmind/credential", {
        method, credentials: "same-origin", mode: "same-origin", redirect: "error", cache: "no-store",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": current.csrf },
        body: JSON.stringify(method === "POST" ? { token: input.current?.value ?? "", consent } : {}),
      });
      const data = await response.json() as Settings;
      setNotice(data.ok ? method === "POST" ? "已保存。網頁與已連接工具現在共用此設定；尚未向 FinMind 驗證金鑰。" : "已停用並移除目前保存的金鑰。網站與工具不再發起新的 FinMind 查詢。" : data.message ?? "未能確認操作結果，請重新檢查狀態。");
    } catch { setNotice("未能確認操作結果，請重新檢查狀態。請勿直接重複提交。"); }
    finally {
      // Do not retain credentials in React state, storage or after submission.
      if (submitted && input.current) input.current.value = "";
      setConsent(false); setConfirmDisable(false);
      await Promise.all([load(), onChange()]);
      setBusy(false);
    }
  };
  return <section className="credential-settings panel" aria-labelledby="credential-title">
    <div className="section-title"><div><p className="eyebrow">FINMIND · 本人設定</p><h2 id="credential-title">{settings?.configured ? "更新或停用金鑰" : "輸入 FinMind key"}</h2></div><span className="limit">僅擁有者</span></div>
    <p className="credential-intro">由你親自輸入一次，後端保存後供網頁及已連接的 FinMind 工具使用。關閉網頁後，工具仍可使用。</p>
    <div className="credential-disclosure" id="credential-disclosure">
      <p>使用此網站既有資料庫的平台加密。伺服器及具資料庫管理權限者仍能讀取原 key；不會把 key 回傳到頁面、對話或工具結果。此程式不把 key 寫入瀏覽器儲存；瀏覽器或密碼管理器的保存提示請自行決定。</p>
      <p>用途僅限此頁列出的台股每日行情及 API 用量查詢。不新增付費服務，仍受既有 Sites 與 FinMind 額度限制。</p>
    </div>
    {!settings ? <p role="status">載入設定中…</p> : !settings.ok ? <div className="notice" role="alert"><p>{settings.message ?? "暫時無法使用設定。請勿輸入金鑰。"}</p><Button variant="outline" onClick={load}>重新載入設定</Button></div> : <>
      <form onSubmit={event => { event.preventDefault(); void submit("POST"); }} autoComplete="off">
        <label htmlFor="finmind-key">FinMind key<Input id="finmind-key" ref={input} type="password" autoComplete="off" spellCheck={false} autoCapitalize="none" minLength={10} maxLength={8192} required disabled={busy} aria-describedby="credential-disclosure" placeholder={settings.configured ? "輸入新 key 以取代目前設定" : "請在這裡親自輸入 key"} /></label>
        <label className="credential-consent"><input type="checkbox" checked={consent} required disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>我同意將此 key 保存於這個私人網站後端，供網頁和已連接工具持續查詢 FinMind，直到我停用。</span></label>
        <div className="credential-actions"><Button type="submit" disabled={busy || !consent}>{busy ? "處理中…" : settings.configured ? "保存並取代金鑰" : "保存金鑰"}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { if (input.current) input.current.value = ""; setConsent(false); setNotice(""); }}>清空輸入</Button></div>
      </form>
      {settings.configured && <div className="credential-revoke"><h3>停用這個網站的存取</h3><p>停止後續查詢並移除目前保存的 key。備份及已開始的請求不一定立即清除。若要撤銷 key 本身，請到 FinMind 操作。</p>{confirmDisable ? <div className="credential-actions"><Button type="button" variant="destructive" disabled={busy} onClick={() => void submit("DELETE")}>確認停用並移除</Button><Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDisable(false)}>取消</Button></div> : <Button type="button" variant="outline" disabled={busy} onClick={() => setConfirmDisable(true)}>停用並移除金鑰</Button>}</div>}
    </>}
    {notice && <p className="notice credential-notice" role="status">{notice}</p>}
    <p className="credential-footnote">請勿將 key 貼到 Slack 或對話。外掛的 Connect 仍需由你本人完成。</p>
  </section>;
}
