# Third-Party Notices

HermOS IDE is licensed under the **MIT License** (see the `LICENSE` file at the
repository root). This product includes third-party software redistributed in
its installers; their licenses are reproduced or referenced below.

## Node.js

The desktop installers embed a bundled Node.js runtime binary (see
`scripts/provision-node-sidecar.mjs`).

Node.js is copyright **OpenJS Foundation and Node.js contributors**,
licensed under the MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Prisma Engines

The desktop installers bundle Prisma query engine binaries (downloaded by
`scripts/ensure-extra-prisma-engines.mjs`).

The Prisma engines are licensed under the **Apache License, Version 2.0**
and are copyright Prisma Data Services ApS and contributors. You may obtain a
copy of the license at <https://www.apache.org/licenses/LICENSE-2.0>. The full
license text and source availability notices are published with the Prisma
repository (<https://github.com/prisma/prisma-engines>). Unless required by
applicable law or agreed to in writing, the engines are distributed on an
"AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
implied.

## Tauri

The application shell is built with Tauri (<https://tauri.app>), which is
copyright the Tauri Programme within The Commons Conservancy and dual-licensed
under **MIT OR Apache-2.0**. Either license applies at your option; see
<https://github.com/tauri-apps/tauri> for the full license texts.

## Other dependencies

All remaining runtime components are npm packages declared in `package.json`
(the authoritative list, including versions). These are predominantly MIT,
BSD, Apache-2.0, or ISC licensed; consult each package's own distribution for
its license text. Nothing in this product's default configuration transmits
telemetry or personal data to third parties.
