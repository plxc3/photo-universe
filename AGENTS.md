# AGENTS.md — AI 智能体部署与定制指南

欢迎！本文件专为 **Claude Code、Cursor、Codex、Trae、Antigravity、Kimi、Windsurf** 等 AI 编程智能体编写。当用户让你「把这个项目跑起来」、「换成我自己的照片」或「修改视觉 / 配乐 / 动效」时，请按以下规范直接执行。

## 1. 环境与一键启动

- **运行环境**：Node.js `>= 20`（推荐 Node.js `22`），纯前端 Vite + Three.js 工程，无需后端数据库或 API Key。
- **安装与启动**：
  ```bash
  npm install
  npm run dev
  ```
  默认开发地址为 `http://127.0.0.1:5178/`（若端口占用，以终端输出的 Vite 地址为准）。
- **测试与构建门禁**：
  任何代码修改完成后，必须运行并通过全部 96 项单元测试与生产构建：
  ```bash
  npm test
  npm run build
  ```

## 2. 如何帮用户接入自己的照片（3 种方式）

1. **零代码直接导入（最推荐普通用户）**：
   启动网页或打开线上版后，直接将本地照片文件夹或多选图片（最多 `3,000` 张 JPG / PNG / WebP）**拖入浏览器窗口**，或点击右下角 `导入`。
   - 所有解码、EXIF 拍摄年份解析、OKLab 六大色温聚类均在**浏览器本地内存**完成，绝不上传服务器。
   - 点击右上角 `索引` -> 勾选 `本机记忆`，即可通过浏览器 IndexedDB（`src/storage.js`）在本机持久化保存相册，下次刷新自动恢复。

2. **替换默认内置馆藏相册（适合部署个人专属纪念站）**：
   - 默认内置的 120 张摄影位于 `public/editorial/`（24 张精选）与 `public/archive/`（96 张年代馆藏），清单定义在 `public/editorial/manifest.json` 与 `public/archive/manifest.json`。
   - 若用户希望将某个本地照片目录打包成默认馆藏：
     1. 将图片放入 `public/custom/`（建议长边压缩至 `1280px–1600px` JPEG，并生成 `440px` 缩略图以保证首屏秒开）。
     2. 仿照 `public/editorial/manifest.json` 生成包含 `file`、`thumb`、`width`、`height`、`title`、`author`、`capturedDate` 的清单，并在 `src/photos.js` 的 `loadDemoPhotos` 中指向新清单。

3. **导出 16:9 / 9:16 高码率漫游视频**：
   - 点击右上角 `索引`，在 `画幅` 中选择 `16:9`（横屏 1920×1080）或 `9:16`（抖音/小红书竖屏 1080×1920），点击 `录制音画`，系统会自动以 `18 Mbps` 码率录制 30 秒五幕漫游与室内乐声景并下载到本地。

## 3. 核心模块地图

| 文件路径 | 职责说明 |
| --- | --- |
| `index.html` | 无边框四角暗房字标（`#stage-hud`）、门扉呼吸层（`#loader`）、展映图注（`#focus-hud`）与接触印相帷幕（`#gallery-dialog`） |
| `src/main.js` | 交互编排、滚轮五幕叙事路由、键盘/触屏手势、年份章节筛选、本机缓存与录制状态机 |
| `src/scene.js` | Three.js 核心渲染器：3,000 实例矩阵、门扉 1.8s 光学变焦、Camera-Space 3D FLIP 离巢与归位、GLSL 液态置换交叉显影 |
| `src/formations.js` | 四大三维空间几何拓扑：24 面超星形八面体 + 四重浑天仪星环（`orbit`）、无限方廊（`tunnel`）、斐波那契球面（`sphere`）、双螺旋（`helix`） |
| `src/flight.js` | 30 秒五幕电影运镜样条曲线、龙卷风坍缩相位与横竖屏自适应取景数学 |
| `src/photos.js` | 本地二进制 JPEG/PNG 尺寸与 EXIF `DateTimeOriginal` 解析、OKLab 六大色温光谱聚类、GPU 显存预算自适应图集构建 |
| `src/post.js` | 暗房胶片后处理管线：物理辉光（UnrealBloom）、光学暗角、胶片微粒与边缘色散 |
| `src/audio.js` | Web Audio 空间声景引擎：24 秒真实大提琴与毛毡钢琴母带（`public/audio/felt-chamber-stem.mp3`）+ 交互泛音调制 |
| `src/storage.js` | 默认关闭、用户显式授权的 IndexedDB 本机相册持久化仓库（`AlbumVault`） |
| `src/recording.js` | `18 Mbps` 影院级 Canvas + Web Audio 音画混流录制器 |
| `src/style.css` | `#020204` OLED 暗房视觉系统、零药丸无边框排版、空闲 2.2s 全清场溶解动效 |

## 4. 修改守则

- 保持 **OLED 纯黑暗房美学（`#020204`）与无边框克制排版**：避免添加廉价玻璃拟态卡片、霓虹描边或臃肿的控制面板。
- 严格保护 GPU 与内存释放闭环：新增 `THREE.Texture`、`ShaderMaterial`、`BufferGeometry` 或 `ObjectURL` 时，必须在 `clearPhotos()` / `dispose()` 中成对释放。
- 尊重无障碍与 `prefers-reduced-motion`：开启系统减弱动态效果时应跳过剧烈旋转与弹簧闪烁。
