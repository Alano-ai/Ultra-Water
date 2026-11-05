# 第三方声明

Ultra Water 以 MIT 许可证发布（参见 [LICENSE](LICENSE)）。其代码中有少量片段改编自下列同样采用 MIT 许可证的项目。按这些项目的许可证要求，其版权声明保留在此处。适用于上述各项目的 MIT 许可证正文位于本文件末尾。

本文件的中文部分仅为便于阅读，许可条款以英文原文为准。

运行时依赖（three.js、lil-gui）通过 npm 安装，其许可证随各自包保存在 `node_modules` 中。`npm run build` 会将它们的许可证正文写入 `dist/licenses.md`，并把本文件复制到 `dist/`，因此两者都会随每次构建一同发布。

## three.js

- 来源：https://github.com/mrdoob/three.js
- 用于：`src/scene/sky.js`（云层，改编自 `Sky.js`）以及 `src/engine/PostFX.js`（AgX 色调映射，数学与 three 的 `AgXToneMapping` 代码块相同。该代码块本身基于 Filament 的 AgX，而后者又遵循 Blender 的实现）。
- Copyright © 2010-2026 three.js authors
- MIT License

## Hash without Sine (Dave Hoskins)

- 来源：https://www.shadertoy.com/view/4djSRW
- 用于：`src/engine/PostFX.js`（`hash33`）、`src/scene/sky.js`（`gradient`）、`src/scene/terrain.js`（`th`、`th3`）、`src/water/OceanSurface.js`（`hash12`，与 `src/water/Spray.js` 共用）以及 `src/water/bakeTextures.js`（`hash22`）
- Copyright (c) 2014 David Hoskins
- MIT License

## UnrealEngineSkyAtmosphere (Sébastien Hillaire)

- 来源：https://github.com/sebh/UnrealEngineSkyAtmosphere
- 用于：`src/scene/atmosphere.js`，其结构遵循 Hillaire 2020《A Scalable and Production Ready Sky and Atmosphere Rendering Technique》的参考实现。
- Copyright (c) 2020 Epic Games, Inc.
- MIT License

## MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
