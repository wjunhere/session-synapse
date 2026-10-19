# vendor/

第三方构建产物，直接放进画布一起发（画布没有打包器，`/synapse/vendor/<name>.js` 就是
这些文件本身）。**不要手改**：升级就是换文件。

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `mermaid.js` | `mermaid` 的 `dist/mermaid.min.js`（UMD，挂 `window.mermaid`） | 11.17.2 | MIT |
| `temml.js` | `temml` 的 `dist/temml.min.js`（IIFE，挂 `window.temml`） | 0.14.0 | MIT |

为什么是 vendored 而不是依赖：画布的 HTML/CSS/JS 由本仓库的服务器直接读文件发出去
（没有构建步骤），而画布可能在没有网络的机器上打开 —— 和两个 woff2 字体同样的理由。
两者都是**按需加载**：页面里没有 ```mermaid 围栏或公式时不请求（`mermaid.js` 3.4 MB
只在真的出现图时加载一次，而且是本机回环，不是 CDN）。

升级步骤（同时改上面的版本号）：

```bash
npm i --no-save mermaid@<版本> temml@<版本>
cp node_modules/mermaid/dist/mermaid.min.js src/canvas/vendor/mermaid.js
cp node_modules/temml/dist/temml.min.js src/canvas/vendor/temml.js
```

调用点都在 `src/canvas/rich-blocks.js`。两处的取值都是刻意的：

- mermaid 用 `securityLevel: 'strict'`（不执行图里的脚本与事件）＋
  `suppressErrorRendering: true`（语法错的图不往页面里塞错误 SVG，改成在画布上把源码显示出来）；
- temml 输出 MathML，浏览器原生渲染 —— 因此不需要 KaTeX 那 60 个字体文件
  （也就不用再加一条二进制资源路由）。
