import { requireChatGPTUser } from "./chatgpt-auth";
import ProxyConsole from "./proxy-console";
export const dynamic = "force-dynamic";
export default async function Page(){ await requireChatGPTUser("/");return <ProxyConsole/>; }
