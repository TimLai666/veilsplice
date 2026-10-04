import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={ title:"VeilSplice 私人服務中心",description:"統一私人服務入口，目前提供 FinMind 台股行情與 API 用量唯讀查詢。",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"},robots:{index:false,follow:false}};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-Hant"><body>{children}</body></html>;}
