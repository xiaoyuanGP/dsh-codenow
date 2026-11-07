# 第三方资源与许可

本插件随附以下 MIT 许可的第三方内容。原始版权归各自作者所有。

## assets/skills/blender-modeling/

- 来源：https://github.com/hwy-miaomiao/blender-modeling
- 许可：MIT License（`LICENSE` 随附件保留）
- 本插件所做的改动：仅删除了 `.git`、`tests/`、`examples/`、`.github/` 目录以控制包体积；技能内容本身未修改。

## assets/skills/create-3d-model/

- 来源：https://github.com/CheshireJCat/create-3d-model-skill（取其 `skills/create-3d-model` 子目录）
- 许可：MIT License（`LICENSE` 随附件保留）
- 本插件所做的改动：仅删除了 `.git`、`tests/`、`examples/`、`.github/` 目录；技能内容本身未修改。

## assets/blender-addon/blender_mcp_addon/

- 来源：`blender-mcp` 项目自带的 Blender 插件（https://github.com/ahujasid/blender-mcp 及其衍生实现）
- 许可：MIT License
- 本插件所做的改动：原样分发，仅删除 `__pycache__`。

## bin/blender-mcp-server.mjs

**不是**上游代码的搬运：这是一个独立实现的最小 MCP stdio 桥，只做「MCP JSON-RPC ↔ Blender addon 的 TCP JSON 行协议」的转发。
它参考了上游 `blender-mcp` 的命令约定（`{type:"command", category, action, params}`，工具名到 `category/action` 的映射），但代码为原创。

当前暴露的工具子集（未逐一验证映射的工具不予暴露，宁缺勿错）：
`blender_connection_status`、`blender_get_info`、`blender_scene_*`、`blender_object_create/transform/delete/duplicate/select/list/get_info/rename/join/parent`、
`blender_execute_python`（→ `utility/execute_python`）、`blender_export_gltf/fbx/obj`、`blender_file_save/open`。

未暴露：`blender_get_viewport_screenshot` 及 AI 生成类工具——上游映射未核实，留待后续按真实调用验证后补。
需要未暴露能力时，用 `blender_execute_python` 直接写 bpy 代码。

## 许可全文

三份上游均为 MIT：

```
MIT License

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
```
