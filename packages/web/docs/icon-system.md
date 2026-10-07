# Know-N 功能图标

网站与浏览器扩展共用 `src/components/icon-paths.ts`。React 的 `Icon` 与扩展的 `src/icons.ts` 只负责渲染，不各自绘制图形。

## 视觉规范

- 24 × 24 坐标，1.5 单位描边，圆角端点与连接；主要轮廓保留约 3 单位边距。
- 使用 `currentColor`，跟随现有冷灰、石板蓝和局部深色卡片主题。
- 默认 20px；密集工具栏 16px；导航及强调场景 24–32px。大尺寸空状态复用同一图形。
- 功能图标以轮廓为主；播放、喜欢、评分及更多操作的小圆点保留实心语义。收藏与已读通过颜色、填充和透明度表达状态，不切换轮廓。
- SVG 均为装饰元素，使用 `aria-hidden` 和 `focusable=false`；按钮名称继续由文字或 `aria-label` 提供。

## 梳理范围

| 原入口 | 统一后 |
| --- | --- |
| `Icon.tsx` 中的通用图标 | 共享路径、网格、描边和填充策略 |
| `ReadMarkGlyph` / `SaveMarkGlyph` / `LibraryNavMark` | 共用勾选、书签与资料库图形；保留状态样式钩子 |
| `EmptyState.tsx` 的八种独立 48px 图标 | 复用通用图形，尺寸由空状态样式管理 |
| 首页浏览器 / 同步 / 代码 / 服务端 | 纳入共享图标库 |
| 天气及桌面模块中的 Unicode 标记 | 天气、时钟、番茄钟、习惯、阅读、终端、热图、AI、单词本 SVG |
| 删除、添加、上传、更多操作、缩放、移动端菜单 | 替换字符与 CSS 绘制的图标 |
| 背景图片适配控件 | Crop / Fit / Tile / Original / Stretch 统一轮廓 |
| 原生 select、扩展 details 展开标记 | 共享下箭头几何；CSS 中保留裁切后的 data URI |
| 扩展 popup / options 静态 SVG | `data-icon` 声明，由同一 DOM 适配器填充；保留原节点与 ID |
| 扩展书签管理、文件夹树、采集结果、分类、说明提示与保存反馈 | 使用同一 DOM 适配器 |

不属于功能图标的资源保持原用途：Know-N 与第三方品牌标记、favicon、头像、封面、图表/知识图谱、计时进度环、纸张纹理、色板与材质效果预览。键盘快捷键、路径分隔符及文本中的数学符号保留为文字。

## 维护与验收

新增图标只编辑 `icon-paths.ts`。扩展静态页面使用 `<svg data-icon="…">`，由入口的 `hydrateIcons(document)` 绘制；动态节点使用 `createIcon(name)`。

在 web 目录运行 `node scripts/preview-icons.mjs`（Node 22.18+），生成无需服务即可打开的 HTML 总览，包含所有图标的 16/20/24/32px 样本和浅深底工具栏。可传入输出目录。

相关验证：web 的 `Icon.test.tsx`、`EmptyState.test.tsx`、导航与 QuickLinks 测试；扩展的 `icons.test.ts`、popup 与书签管理 UI 契约。浏览器检查需在 xvfb 下运行。
