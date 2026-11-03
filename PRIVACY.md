# 隐私政策 · Privacy Policy

**网站鉴权分析器 / Site Auth Inspector**

最后更新：2026-10-28

## 中文

本扩展是一个本地运行的浏览器接口调试辅助工具，用于分析网站如何识别登录状态。

1. **只在授权站点上工作**：默认没有任何网站访问权限。只有你在某个网站上点击「启用此网站」并在 Chrome 权限弹框中确认后，扩展才会读取该站点的 Cookie、本地存储（localStorage / sessionStorage）以及页面发出的请求头。
2. **不收集、不上传**：所有分析都在你的浏览器内完成，不会把任何数据发送到任何服务器，也不包含任何统计、广告或第三方追踪代码。
3. **数据只保存在本地**：完整分析结果（可能包含 Cookie / Token）保存在浏览器会话存储 `chrome.storage.session` 中，关闭浏览器后自动清除；站点列表与设置保存在本地 `chrome.storage.local`，其中不含任何凭证。
4. **默认脱敏**：界面默认只显示凭证的首尾字符，只有你主动点击复制时才使用原始值。
5. **随时可撤销**：在弹窗或设置页点击「停用」会立即撤销该站点的权限、移除注入的脚本，并删除对应的分析结果。
6. **不做的事**：不出售数据、不用于广告或信用评估、不读取未授权站点、不加载任何远程代码。

如对本政策有疑问，可通过扩展商店页面提供的联系方式联系开发者。

## English

This extension is a local browser API debugging aid that analyzes how a website recognizes
that you are signed in.

1. **Only on sites you authorize.** The extension has no site access by default. It reads a
   site's cookies, local/session storage and outgoing request headers only after you click
   "Enable this site" and confirm the Chrome permission prompt.
2. **No collection, no uploads.** All analysis happens inside your browser. No data is sent to
   any server. There is no analytics, advertising or third-party tracking code.
3. **Local storage only.** Full results (which may contain cookies or tokens) are kept in
   `chrome.storage.session` and cleared when the browser closes. The site list and settings live
   in `chrome.storage.local` and never contain credentials.
4. **Masked by default.** Values are shown masked; the raw value is used only when you click copy.
5. **Revocable at any time.** "Disable" immediately revokes the site permission, removes the
   injected scripts and deletes the stored result.
6. **What it never does.** No data selling, no advertising or credit-worthiness use, no reading
   unauthorized sites, no remote code.

For questions about this policy, contact the developer via the contact details on the store listing.
