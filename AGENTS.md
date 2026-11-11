# AGENTS.md — AI 智能体工程规范与定制指南

欢迎！本文件是 `Memoria · 记忆的形状`（`/Users/pc/IdeaProjects/projects/photo-universe`）的唯一 AI 工程宪章，供 **Claude Code（通过 `@AGENTS.md`）、Codex、Antigravity、Cursor、Qoder、Trae、Windsurf** 统一加载。

本项目同时遵循父工作区 `/Users/pc/IdeaProjects/AGENTS.md` 的核心纪律：
- **零构建污染与零大文件入库**：本地音视频成片（`*.mp4`、`*.webm`、`抖音发布素材包/`）、IDE 配置（`.idea/`、`.vscode/`）及敏感凭证严禁提交 Git。
- **单文件轻量模块化边界**：每个业务 JS / CSS 源文件严格保持单一职责（`< 1,000` 行，单次上下文窗口完整可读），禁止退化回单体巨石文件。
- **统一验证门禁**：任何修改完成后，必须通过 `npm run check`（全量测试 + Vite 分包生产构建）。

---

## 1. 环境与标准命令

- **运行环境**：Node.js `>= 20`（推荐 Node.js `22`），**零第三方 UI 框架膨胀**（仅 `three` 运行时依赖 + `vite` 构建工具），无需后端或 API Key。
- **常用命令**：
  ```bash
  npm install
  npm run dev      # 启动本地开发服务 http://127.0.0.1:5178/
  npm test         # 运行 Node 原生单元测试套件（src/*.test.js）
  npm run build    # Vite 生产分包构建（three 独立 vendor chunk + 业务轻包）
  npm run check    # 合并/提交前强制门禁：npm test && npm run build
  ```

---

## 2. 如何帮用户接入自己的照片与导出成片

1. **零代码直接导入（最推荐）**：
   启动页面后，直接将本地照片文件夹或多选图片（最多 `3,000` 张 JPG / PNG / WebP）**拖入浏览器窗口**，或点击右下角 `导入`。
   - 所有解码、EXIF `DateTimeOriginal` 拍摄年份解析、OKLab 六大色温聚类均在**浏览器本地内存**完成，绝不上传服务器。
   - 点击右上角 `索引` -> 勾选 `本机记忆`，即可通过浏览器 IndexedDB（`src/storage.js`）在本机持久化保存相册。

2. **替换默认内置馆藏相册**：
   - 默认内置的 120 张摄影位于 `public/editorial/`（24 张精选）与 `public/archive/`（96 张年代馆藏），清单定义在对应目录下的 `manifest.json`（单张体积控制在 `< 410 KB`）。
   - 如需替换默认馆藏，建议将长边压缩至 `1280px–1600px` JPEG 并生成 `440px` 缩略图，在 `src/photos.js` 的 `loadDemoPhotos` 中指向新清单。

3. **导出 16:9 / 9:16 影院级漫游视频**：
   - 点击右上角 `索引` -> `画幅` 选择 `16:9` 或 `9:16` -> 点击 `录制音画`，以 `18 Mbps` 码率录制 30 秒五幕漫游与室内乐声景并下载到本地（注意：导出的 `.mp4` / `.webm` 属于本地交付产物，切勿提交到 Git）。

---

## 3. 模块化架构地图

### WebGL 三维引擎与着色器层
| 文件路径 | 职责说明 |
| --- | --- |
| `src/scene.js` | `PhotoUniverse` 核心协调器：场景初始化、自适应视口、门扉 1.8s 光学变焦、主帧循环（`animate`）与 GPU 资源生命周期释放 |
| `src/morph-engine.js` | 3,000 实例拓扑切换、龙卷风坍缩（`vortex`）、经线球壳弧线过渡（`shellArc`）与 `instanceMatrix` 批量上传 |
| `src/focus-stage.js` | 全画幅展映舞台：Camera-Space 3D FLIP 无回弹离巢/归位、帧零高清预解码、GLSL 液态置换丝绸切图 |
| `src/scroll-theatre.js` | 30 秒电影自动漫游与可逆五幕滚轮叙事：实时姿态无跳变接管（Live-Pose Handoff）、轨道↔走廊连续环视混合与拖拽惯性滑行 |
| `src/pointer-picking.js` | 指针手势状态机、射线拾取（Raycasting）与悬停波纹瞬时入场同步（`uHoverWorld`） |
| `src/shaders.js` | GLSL 着色器工厂：实例化暗房相纸材质（景深散景/悬停波纹）与全画幅独立画幅比（`coverUv`）液态显影材质 |
| `src/formations.js` | 四大三维几何拓扑：`orbit`（24 面超星形八面体 + 四重浑天仪星环）、`tunnel`（螺旋方廊）、`sphere`（斐波那契球面）、`helix`（双螺旋） |
| `src/flight.js` | 五幕运镜样条曲线、龙卷风坍缩相位与横竖屏自适应取景数学 |
| `src/pool.js` | 六大色温光谱均匀采样池、黄金角邻位去重与安全相纸画幅比换算 |
| `src/post.js` | 暗房胶片后处理管线：UnrealBloom 物理辉光、光学暗角、胶片微粒、边缘色散与慢帧自动降级 |

### 数据、音频、存储与 UI 编排层
| 文件路径 | 职责说明 |
| --- | --- |
| `src/main.js` | 应用顶层胶水层：门扉解锁、四角 HUD 状态机、统一滚轮路由（门扉/展映防连跳门控/五幕叙事）与拖拽导入 |
| `src/focus-ui.js` | 全画幅展映图注（底片刻度尺、色温标尺切换动效）与无 WebGL 环境的 HTML 降级灯箱 |
| `src/gallery-ui.js` | 接触印相暗房索引帷幕（`#gallery-dialog`）：年份章节筛选、交错渐显网格（Staggered Contact Sheet）与丝滑退场动画 |
| `src/cinema-export-ui.js` | 30 秒自动漫游控制、16:9 / 9:16 音画录制器绑定、底边时间轴拖拽擦除与帧率采样面板 |
| `src/reticle.js` | 帧间隔无关（`dt`-damped）的光学十字游标与 MacBook 触控板惯性防连跳门控（`createWheelStepGate`） |
| `src/photos.js` | 本地与馆藏照片加载、OKLab 光谱聚类、GPU 显存预算自适应图集构建（`buildPhotoAtlases`） |
| `src/image-headers.js` | 零依赖二进制头部解析器：JPEG/PNG 尺寸、EXIF `Orientation` / `DateTimeOriginal`（II/MM 字节序）与 PNG `tIME` |
| `src/audio.js` | Web Audio 空间声景引擎：按需懒加载 24 秒真实大提琴与毛毡钢琴母带 + 交互泛音调制 |
| `src/storage.js` | 默认关闭、用户显式授权的 IndexedDB 本机相册持久化仓库（`AlbumVault`） |
| `src/recording.js` | `18 Mbps` 影院级 Canvas + Web Audio 音画混流录制器 |
| `src/styles/` | 模块化暗房样式表：`base.css`（设计令牌与门扉）、`stage.css`（四角无边框字标与展映 HUD）、`overlays.css`（接触印相帷幕与响应式） |

---

## 4. 修改守则

1. **视觉克制**：保持 `#020204` OLED 纯黑暗房美学与无边框编辑部排版，禁止引入廉价毛玻璃卡片、霓虹描边或冗余悬浮按钮。
2. **丝滑连续性（Zero-Snap Motion）**：任何运镜、形态或展映状态切换必须继承当前帧真实位置/四元数/速度（`Hermite C1` / `C2` 缓动或实时姿态捕获），禁止硬切跳帧。
3. **GPU 与内存闭环**：新增 `THREE.Texture`、`ShaderMaterial`、`BufferGeometry` 或 `ObjectURL` 时，必须在 `clearPhotos()` / `dispose()` 中成对释放。
4. **无障碍兼容**：所有新增动画必须尊重 `prefers-reduced-motion: reduce`。
