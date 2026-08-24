# OpenGL 1.1-2.1 on WebGPU

The host half of the OpenGL path. The guest DLL
(`../openglproxy/opengl32_proxy.c`) is unchanged by the move off gl4es: it still
serialises the same 217 opcodes into the same PCI DMA arena. What changed is
everything after the opcode.

```text
game.exe
  -> opengl32.dll            (../openglproxy, unchanged)
  -> v86gl.sys / PCI DMA     (../v86gl_driver, unchanged)
  -> v86_network_bridge.js   (routing only)
  -> gl_executor.js          GL state machine, resources, pipelines
       gl_shader_translator.js   GLSL 1.10/1.20 -> WGSL
       gl_fixed_function.js      the fixed pipeline, generated as WGSL
       gl_arb_program.js         ARB assembly programs -> WGSL
       gl_state_layout.js        the GL state uniform block, shared by all three
       gl_wire.js, gl_constants.js  generated from the guest
  -> ../webgpu_host.js       one GPUDevice and one canvas, shared with D3D9
  -> WebGPU / WGSL           #d3d_webgpu_canvas
```

Design notes live in
`../../docs/opengl-webgpu-implementation-plan.zh-CN.md`; this file is the
record of what the implementation actually does, and
[COVERAGE.md](COVERAGE.md) is the per-entry-point table.

## Three decisions worth knowing before reading the code

**The authoritative GL state machine is here, not in the guest.** That is what
lets `glGetError`, `glGetIntegerv`, `glGetString`, `glGetUniformLocation`,
`glGetShaderiv` and `glCheckFramebufferStatus` be answered inside the port
write that delivered them -- the guest is blocked in `DeviceIoControl` and
reads the answer out of the record it submitted. Only `glReadPixels` and
occlusion-query results need a GPU round trip, and those are the only two
places the guest spins.

**Clip space is flipped once, in the vertex shader** (`clip.y = -clip.y`).
Framebuffer row 0 is then GL's bottom row, so `glViewport`, `glScissor`,
`glReadPixels`, `glCopyTexImage2D` and render-to-texture orientation all need
no conversion at all. The two costs are reversed winding -- which lives in
exactly one function, `gpuFrontFace()` -- and a flip in the present blit.

**A draw resolves state into a signature and looks the pipeline up.** Any
state that changes the picture must reach the signature. A field that does not
is a bug whose symptom is "I changed the state and nothing happened", which is
the hardest class of bug in this directory to find;
`tests/gl_fixed_function_wgsl_test.js` walks every signature field to keep it
honest.

## Known deviations

WebGPU cannot express some of OpenGL exactly. Every case is listed here with
what it does instead and when the difference is visible. Numbers are permanent:
if a deviation is later eliminated the entry stays, marked as such.

| Code | Feature | What happens instead | When it shows |
| --- | --- | --- | --- |
| D-01 | `glLogicOp` | WebGPU has no logic-op blending. `GL_COPY` (the default) is free; enabling `GL_COLOR_LOGIC_OP` is currently refused and counted rather than emulated | Rubber-band selection drawn with `GL_XOR` does not appear |
| D-02 | Separate two-sided stencil masks | WebGPU has one `stencilReadMask` and one `stencilWriteMask` for both faces; the front face's are used and the divergence is reported once | Only algorithms that set different front and back masks -- a rare stencil-shadow variant |
| D-03 | `GL_CLAMP`, `GL_CLAMP_TO_BORDER` | WebGPU has no border addressing; the sampler clamps to edge | A texture sampled outside [0,1] with a border colour shows the edge texel instead of the border |
| D-04 | Line width > 1, `GL_LINE_SMOOTH`, `GL_POLYGON_SMOOTH` | WebGPU draws one-pixel lines and has no smooth hint. Wide lines are not yet expanded to quads | Wide or antialiased lines draw one pixel wide and hard-edged |
| D-05 | User clip planes | Implemented as a fragment `discard` on an interpolated distance, not as geometry clipping (WebGPU's `clip-distances` feature is not yet available anywhere) | Geometry is not actually clipped, only its fragments; a depth pre-pass combined with clip planes can differ |
| D-06 | Multisampling | WebGPU defines sample counts 1 and 4 only; `glSampleCoverage`'s value has no exact expression | 2x and 8x requests get 4x; the coverage value's subsample pattern differs |
| D-07 | Occlusion query sample counts | WebGPU's occlusion query answers "did any sample pass"; a visible result reports a saturated count | An algorithm thresholding on the *number* of samples sees the saturated value |
| D-08 | `glDrawBuffer(GL_FRONT)` | There is no front buffer; writes to it are refused and counted | Old debugging code that draws directly to the front buffer produces nothing |
| D-09 | Accumulation buffer | `glAccum` and `GL_ACCUM_BUFFER_BIT` are refused and counted | Motion blur and full-scene antialiasing built on the accumulation buffer do not render |
| D-10 | Texture fetch in non-uniform control flow | `textureSample` requires uniform control flow; a fetch inside a conditional or loop uses `textureSampleGrad` with the coordinate's derivatives. Counted as `stats.nonUniformSamples` | Mip selection inside a divergent branch can differ slightly from desktop |
| D-11 | `noise1()` … `noise4()` | Return 0, which the GLSL spec permits and every desktop driver does | A shader genuinely relying on GLSL noise -- already broken on real hardware |
| D-12 | `GL_MAX_VARYING_FLOATS` | 16 vec4 slots (WebGPU's `maxInterStageShaderVariables`), reported as 64 floats. Linking fails with a message naming this code when a program needs more | A program with more than 16 packed varying slots does not link. Desktop's floor is 8 vec4, so this is the more generous limit |
| D-13 | `glFinish` | Answered after `queue.submit()` rather than after `onSubmittedWorkDone()` | Code using `glFinish` to time GPU work measures submission, not completion |
| D-14 | Colour-index rendering | `glIndex*` and a colour-index framebuffer are not implemented (paletted *textures* are) | 1996-era colour-index code produces nothing; no target game uses it |
| D-15 | `glDrawPixels`, `glBitmap`, `glCopyPixels` | Refused and counted; the textured-quad implementation is an M6 item | Loading screens and text drawn with pixel rectangles do not appear |
| D-16 | Line and polygon stipple | The patterns are stored and reported but not yet applied in the shader | Stippled lines and polygons draw solid |
| D-17 | `glPolygonMode(GL_LINE\|GL_POINT)` | Not yet expanded into line or point primitives | Wireframe mode draws filled |
| D-18 | An ARB program on one stage with the fixed pipeline on the other | Refused: the two do not share a varying layout | A program enabling only `GL_VERTEX_PROGRAM_ARB` draws nothing, loudly |

Refusals are never silent. Each one logs once with enough context to locate
it, increments `getStats().refusals`, and -- where GL defines an error for the
situation -- sets it so `glGetError` reports it.

## Capability reporting

`glGetString(GL_EXTENSIONS)` and every `GL_MAX_*` are decided by what this
executor implements against the adapter it actually got, never guessed:

- `GL_EXT_texture_compression_s3tc` is advertised only when the adapter has
  `texture-compression-bc`. Without it, DXT blocks are still accepted and
  decoded deterministically on the CPU, so the picture is identical -- but the
  extension is not claimed, because a guest that believes it will keep handing
  us compressed data forever and deserves to choose.
- `GL_ARB_texture_float` and `GL_ARB_half_float_pixel` require
  `float32-filterable`.
- `GL_ARB_depth_clamp` requires `depth-clip-control`.
- `GL_MAX_TEXTURE_SIZE` and friends come from the device's limits.

`glGetString(GL_VERSION)` reports `2.1` and `GL_SHADING_LANGUAGE_VERSION`
reports `1.20`.

## Running the tests

```bash
cd glbridge
node tests/gl_protocol_consistency_test.js     # the wire format against the guest
node tests/gl_shader_translator_test.js        # the GLSL front end
node tests/gl_shader_wgsl_validation_test.js   # its output, through naga
node tests/gl_fixed_function_wgsl_test.js      # the fixed pipeline, through naga
node tests/gl_arb_program_test.js              # ARB assembly, through naga
node tests/gl_executor_test.js                 # the state machine and draw path
node tests/v86_network_bridge_gl_route_test.js # routing
node tools/gen_gl_coverage.js                  # regenerate COVERAGE.md
```

The three suites that say "through naga" validate their generated WGSL with
the compiler wgpu and Firefox use. It is optional -- they skip without it --
but it is the difference between "the translator produced a string" and "the
translator produced a shader", so install it:

```bash
cargo install naga-cli
```

## Falling back

`installV86GLNetworkBridge(..., { glBackend: "gl4es" })`, or `?glBackend=gl4es`
on the game page, routes the OpenGL stream to the old WebGL2 host instead. The
switch exists so that a milestone going wrong is one string away from the
previous behaviour rather than a revert. It is removed, along with
`../libglwasm/`, at M7.

## Where new work goes

New OpenGL work belongs in this directory or in `../openglproxy/` -- never a
second backend, and never in `../libglwasm/`, which is on its way out. A new
deviation gets the next free code in the table above; an eliminated one keeps
its code and is marked resolved.
