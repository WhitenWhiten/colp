# 同步审计逐任务提交索引 — 2026-10-20

此索引覆盖集成基线 `a7800c8877edb51179a6137376834bb02b3ed03a` 之后、审查代码提交 `0922c112bd649f5e0ddf75d7ee6c319579359b86` 为止、沿第一父链追踪的 **269 个独立提交**。提交数包括复现、产品修复、补测、审查后修正和发布检查，不代表相同数量的独立缺陷。5 个保留的既有 PR 分支提交单列于末尾附录；报告和文档校正提交也不包含在上表计数内。

每项 S01–S25 均有单独的主修复提交；多个任务共享的后续边界修复列出全部相关编号。未在标题中标记编号的独立审查测试，按验证行为归入对应任务。原始失败复现和后续修正分别保留，没有 squash。

## 主修复

| 任务 | 内容 | 主提交 | 相关提交数 |
|---|---|---|---:|
| S01 | 当前同步范围与权限 | [d5087b166dd1](https://github.com/WhitenWhiten/colp/commit/d5087b166dd12d8e47e82825cf4f53de60a1c389) | 34 |
| S02 | 首次同步的持久确认 | [72069e9f8a5b](https://github.com/WhitenWhiten/colp/commit/72069e9f8a5ba047eef3dd9623b025ce31e1bef4) | 5 |
| S03 | URL 身份 | [8e2d77267bac](https://github.com/WhitenWhiten/colp/commit/8e2d77267baca15cf1f494a45362260195c8ff81) | 3 |
| S04 | 多字段编辑与合并 | [bc175058a1fd](https://github.com/WhitenWhiten/colp/commit/bc175058a1fda06755eed2cb384a8c76b217002d) | 4 |
| S05 | 远端删除与本地未完成工作 | [b69a0bb605e0](https://github.com/WhitenWhiten/colp/commit/b69a0bb605e023c28b8817ee429b424c209f7628) | 14 |
| S06 | 浏览器 create 回声身份 | [d3c8e85b8301](https://github.com/WhitenWhiten/colp/commit/d3c8e85b83012740fad7fa6a267001a7f336c2fc) | 3 |
| S07 | 回声后的连续用户编辑 | [324b227b263e](https://github.com/WhitenWhiten/colp/commit/324b227b263ead2ccea91e3325c3d0941ec14b44) | 32 |
| S08 | 排序、历史增长与首次同步性能 | [6cc821223b98](https://github.com/WhitenWhiten/colp/commit/6cc821223b9801fc4f818a9767a3552ccf121e09) | 14 |
| S09 | 暂停、重新加入与删除决策 | [c7e2c7cb3e39](https://github.com/WhitenWhiten/colp/commit/c7e2c7cb3e391b4b04aefa27e10fcf17d482f572) | 35 |
| S10 | 账号、设备和浏览器根目录隔离 | [49468a1391dc](https://github.com/WhitenWhiten/colp/commit/49468a1391dca8d7da465088623f900714e0f28f) | 5 |
| S11 | 空书签标题 | [3c9e86ea246d](https://github.com/WhitenWhiten/colp/commit/3c9e86ea246de9ccd0c0f32051326be1067bb961) | 4 |
| S12 | 标题与文本契约 | [07d60498ba5b](https://github.com/WhitenWhiten/colp/commit/07d60498ba5b0b6023ef2738af1cecc557d8460d) | 6 |
| S13 | URL 元数据来源 | [2184f0f0e664](https://github.com/WhitenWhiten/colp/commit/2184f0f0e664249cd9ff886b5807b24568aed76c) | 4 |
| S14 | 扩展命名空间持久化 | [d50379c6cd4a](https://github.com/WhitenWhiten/colp/commit/d50379c6cd4a61f031346036d0640db54201e6bf) | 2 |
| S15 | 可执行的冲突选择 | [162c34bec614](https://github.com/WhitenWhiten/colp/commit/162c34bec614eca9d244b529686c51c7e026091c) | 14 |
| S16 | 只同步根目录直属书签 | [22090736dc7c](https://github.com/WhitenWhiten/colp/commit/22090736dc7c6c04b6b578402741c8caf400ba34) | 2 |
| S17 | 确认超时与重新打开 | [8bd4a8550bbe](https://github.com/WhitenWhiten/colp/commit/8bd4a8550bbe6d7ce1c4299f40b16ad951e71d11) | 7 |
| S18 | 稍后处理的真实含义 | [2cc039587ac3](https://github.com/WhitenWhiten/colp/commit/2cc039587ac389d4596752b6aa43f69d2fade211) | 1 |
| S19 | 多个设置页并发 | [ed71342c2e40](https://github.com/WhitenWhiten/colp/commit/ed71342c2e406ba49c7123b83325c2318d4c4b12) | 4 |
| S20 | 保存完成反馈 | [07da80a3c176](https://github.com/WhitenWhiten/colp/commit/07da80a3c1761c8be8b855714d30267ebc4ee34c) | 2 |
| S21 | 进度、问题提示与恢复入口 | [efd457189d56](https://github.com/WhitenWhiten/colp/commit/efd457189d5644532a714f4d2c21b295bf24431c) | 5 |
| S22 | 真实场景与发布检查 | [a7719218002b](https://github.com/WhitenWhiten/colp/commit/a7719218002bc694ae3bae46764fadb43cdc391f) | 79 |
| S23 | 不支持的恢复位置 | [de3ad96c677a](https://github.com/WhitenWhiten/colp/commit/de3ad96c677a20739ff9c47cd221e16819519ba0) | 1 |
| S24 | 范围命令中断恢复 | [741c9f2c0bf1](https://github.com/WhitenWhiten/colp/commit/741c9f2c0bf1d538ed2266ff2ffcc782015d6ed7) | 21 |
| S25 | 本地不支持的 URL | [56abbcec539b](https://github.com/WhitenWhiten/colp/commit/56abbcec539b83d614403c4a37024ec9f3516f22) | 2 |

相关提交可交叉归属，不能把各行相加作为总提交数。

## 本轮第一父链提交序列

| 序号 | 任务 | 提交 | 提交主题 |
|---:|---|---|---|
| 1 | S22 | [a798a99672a7](https://github.com/WhitenWhiten/colp/commit/a798a99672a70fc5c6d43749b05312a3f269af57) | [S22] Reconcile the audited PR with current main |
| 2 | S03 | [8e2d77267bac](https://github.com/WhitenWhiten/colp/commit/8e2d77267baca15cf1f494a45362260195c8ff81) | [S03] Preserve fragment routes and path slashes in bookmark URL edits |
| 3 | S03 | [b105a351f461](https://github.com/WhitenWhiten/colp/commit/b105a351f46180fb9a22488960eea2c227a8683f) | fixup! [S03] Preserve fragment routes and path slashes in bookmark URL edits |
| 4 | S10 | [49468a1391dc](https://github.com/WhitenWhiten/colp/commit/49468a1391dca8d7da465088623f900714e0f28f) | fix(extension): keep account and device bookmark roots independent (S10) |
| 5 | S10 | [a728380d2f4b](https://github.com/WhitenWhiten/colp/commit/a728380d2f4b08b842c6bd691db3409eeb31ad6f) | fix(extension): preserve secondary root ancestry in partial sync (S10) |
| 6 | S10 | [530098158e24](https://github.com/WhitenWhiten/colp/commit/530098158e2453d1eb6dd434ddc5679363b89da1) | fix(extension): narrow canonical browser root role types (S10) |
| 7 | S06 | [d3c8e85b8301](https://github.com/WhitenWhiten/colp/commit/d3c8e85b83012740fad7fa6a267001a7f336c2fc) | fix(extension): bind completed create echoes to native identity (S06) |
| 8 | S07 | [324b227b263e](https://github.com/WhitenWhiten/colp/commit/324b227b263ead2ccea91e3325c3d0941ec14b44) | fix(extension): preserve user moves after completed pull echoes (S07) |
| 9 | S05 | [b69a0bb605e0](https://github.com/WhitenWhiten/colp/commit/b69a0bb605e023c28b8817ee429b424c209f7628) | fix(extension): retain unsettled local edits before remote deletion (S05) |
| 10 | S16 | [22090736dc7c](https://github.com/WhitenWhiten/colp/commit/22090736dc7c6c04b6b578402741c8caf400ba34) | [S16] Allow syncing direct bookmarks with all child folders excluded |
| 11 | S02 | [72069e9f8a5b](https://github.com/WhitenWhiten/colp/commit/72069e9f8a5ba047eef3dd9623b025ce31e1bef4) | [S02] Persist first-run confirmation admission and protect newer ranges |
| 12 | S17 | [8bd4a8550bbe](https://github.com/WhitenWhiten/colp/commit/8bd4a8550bbe6d7ce1c4299f40b16ad951e71d11) | [S17] Recover exact confirmations across lost replies and page changes |
| 13 | S04 | [bc175058a1fd](https://github.com/WhitenWhiten/colp/commit/bc175058a1fda06755eed2cb384a8c76b217002d) | [S04] Retain and resolve complete multi-field bookmark edits |
| 14 | S04 | [43c3c716246c](https://github.com/WhitenWhiten/colp/commit/43c3c716246c439515d0775946815e23da65d7ab) | fixup! [S04] Type the conflict serializer SQL test boundary |
| 15 | S05 | [2f732da12f32](https://github.com/WhitenWhiten/colp/commit/2f732da12f328e03559e8b70340b0f6aedfd3100) | [S05] Recover deleted descendant edits after current canonical migrations |
| 16 | S11 | [3c9e86ea246d](https://github.com/WhitenWhiten/colp/commit/3c9e86ea246de9ccd0c0f32051326be1067bb961) | [S11] Preserve empty bookmark titles with current API baseline |
| 17 | S12 | [07d60498ba5b](https://github.com/WhitenWhiten/colp/commit/07d60498ba5b0b6023ef2738af1cecc557d8460d) | [S12] Generate one title support policy for browser ingress and server validation |
| 18 | S13 | [2184f0f0e664](https://github.com/WhitenWhiten/colp/commit/2184f0f0e664249cd9ff886b5807b24568aed76c) | [S13] Invalidate stale URL metadata for browser edits and recovered copies |
| 19 | S14 | [d50379c6cd4a](https://github.com/WhitenWhiten/colp/commit/d50379c6cd4a61f031346036d0640db54201e6bf) | [S14] Persist resolved extension namespaces through canonical mutation |
| 20 | S15 | [162c34bec614](https://github.com/WhitenWhiten/colp/commit/162c34bec614eca9d244b529686c51c7e026091c) | [S15] Align conflict decision menus with retained intent and executable choices |
| 21 | S23 | [de3ad96c677a](https://github.com/WhitenWhiten/colp/commit/de3ad96c677a20739ff9c47cd221e16819519ba0) | [S23] Reject unsupported restore placement without mutating or acknowledging it |
| 22 | S04 | [e597c46a6130](https://github.com/WhitenWhiten/colp/commit/e597c46a6130ee03b3696616b0de8b576b575b46) | [S04][R2] Resolve only competing namespaces and preserve independent changes |
| 23 | S13 | [a5130f4adb23](https://github.com/WhitenWhiten/colp/commit/a5130f4adb23f9802837cd861e038577d45b0663) | [S13][R2] Validate authored URL hashes and preserve explicit clears |
| 24 | S01 | [d5087b166dd1](https://github.com/WhitenWhiten/colp/commit/d5087b166dd12d8e47e82825cf4f53de60a1c389) | fix(extension): enforce current boundaries at every upload dispatch (S01) |
| 25 | S18 | [2cc039587ac3](https://github.com/WhitenWhiten/colp/commit/2cc039587ac389d4596752b6aa43f69d2fade211) | [S18] Keep Later truthful and preserve newer sync authority |
| 26 | S19 | [ed71342c2e40](https://github.com/WhitenWhiten/colp/commit/ed71342c2e406ba49c7123b83325c2318d4c4b12) | [S19] Keep root views valid across concurrent options pages |
| 27 | S20 | [07da80a3c176](https://github.com/WhitenWhiten/colp/commit/07da80a3c1761c8be8b855714d30267ebc4ee34c) | [S20] Require committed range receipts before reporting settings saved |
| 28 | S21 | [efd457189d56](https://github.com/WhitenWhiten/colp/commit/efd457189d5644532a714f4d2c21b295bf24431c) | [S21] Project sync progress from the current confirmed boundary |
| 29 | S08 | [6cc821223b98](https://github.com/WhitenWhiten/colp/commit/6cc821223b9801fc4f818a9767a3552ccf121e09) | fix(extension): recover relative bookmark order after missed events (S08) |
| 30 | S22 | [d6b58059bf53](https://github.com/WhitenWhiten/colp/commit/d6b58059bf53e2a6c74d8c74a4c7315184d9815c) | [S22] Require real browser lifecycle lanes and exact release acceptance |
| 31 | S08 | [aae5c01dbc52](https://github.com/WhitenWhiten/colp/commit/aae5c01dbc527b9279ff6760cfbda530478141ef) | perf(extension): bound deep rejoin ancestry and topology scans (S08) |
| 32 | S15 | [5abae554a4f4](https://github.com/WhitenWhiten/colp/commit/5abae554a4f47fab258806354430b1d6f011bfd7) | [S15][R2] Refresh conflict decisions against locked canonical state |
| 33 | S09 | [ef0967a82db7](https://github.com/WhitenWhiten/colp/commit/ef0967a82db7bde7f30bb2eda27c77f4f6624747) | fix(extension): page rejoin evidence and archive it atomically (S09) |
| 34 | S02 | [fc59c32d6721](https://github.com/WhitenWhiten/colp/commit/fc59c32d672199dc6243866584a82323563e6def) | [S02] Build advanced fixtures against their actual boundary version |
| 35 | S17 | [1a5335715017](https://github.com/WhitenWhiten/colp/commit/1a533571501703726256570d2854773657bdd672) | fix(extension): restore first-run request type import [S17] |
| 36 | S22 | [696025748fbd](https://github.com/WhitenWhiten/colp/commit/696025748fbdc27046a7a848c2f6255864196572) | [S22] Exercise options HTTP and await logout page cleanup |
| 37 | S16, S19 | [e21a5b20f4b0](https://github.com/WhitenWhiten/colp/commit/e21a5b20f4b020e4473199b1d7d3793f51eb34ab) | style(extension): normalize sync regression fixture endings [S16][S19] |
| 38 | S20 | [0b10209898e1](https://github.com/WhitenWhiten/colp/commit/0b10209898e118dc4fee3507dd73e5e0a153acac) | test(extension): assert classified tree outage without saved feedback [S20] |
| 39 | S24 | [741c9f2c0bf1](https://github.com/WhitenWhiten/colp/commit/741c9f2c0bf1d538ed2266ff2ffcc782015d6ed7) | fix(extension): durably resume reviewed range commands across interruption [S24] |
| 40 | S09 | [c7e2c7cb3e39](https://github.com/WhitenWhiten/colp/commit/c7e2c7cb3e391b4b04aefa27e10fcf17d482f572) | fix(extension): resume complete rejoin decisions with native receipts (S09) |
| 41 | S05 | [fdb7d55870c9](https://github.com/WhitenWhiten/colp/commit/fdb7d55870c9439db848aa31a1f73fc41cc758f3) | [S05] Cover captured moves beyond one thousand processed events |
| 42 | S15 | [63f58e16070c](https://github.com/WhitenWhiten/colp/commit/63f58e16070cc0490a3fa27870edb2cfc0572ba0) | fix(web): require an available fresh conflict decision after stale replies [S15] |
| 43 | S09 | [89b44d85d33c](https://github.com/WhitenWhiten/colp/commit/89b44d85d33c9e47c36895a3254c46c405399a41) | test(extension): exercise paused deletion recovery across MV3 restarts (S09) |
| 44 | S24 | [e75bad2360e2](https://github.com/WhitenWhiten/colp/commit/e75bad2360e2d65925f50ee5b89664bfe44f64fb) | test(extension): exercise range recovery through real ACK and wide cloud deletion [S24] |
| 45 | S25 | [56abbcec539b](https://github.com/WhitenWhiten/colp/commit/56abbcec539b83d614403c4a37024ec9f3516f22) | [S25] Explain and retain unsupported local bookmarks during first sync |
| 46 | S09 | [d541fee4dd55](https://github.com/WhitenWhiten/colp/commit/d541fee4dd55f624e7bf795afb497c3384c11913) | fix(extension): recover refused rejoin choices without erasing receipts (S09) |
| 47 | S09 | [221748f1cc14](https://github.com/WhitenWhiten/colp/commit/221748f1cc1465fe7a30318c2324309f67c573c1) | fix(extension): refresh rejoin decision titles from cloud authority (S09) |
| 48 | S08 | [015b3865f6d3](https://github.com/WhitenWhiten/colp/commit/015b3865f6d373479682b3921a70cc387af0e29c) | [S08] Cover remote insert order across restart and expired echoes |
| 49 | S09 | [40fb85664a2b](https://github.com/WhitenWhiten/colp/commit/40fb85664a2bf36b6a5b2dbd7ee97ec16721e720) | [S09] Cover compacted self-delete recovery after a Pull crash |
| 50 | S24 | [4c3fbde90f3d](https://github.com/WhitenWhiten/colp/commit/4c3fbde90f3db046507d5a6ec508587728c2eccc) | test(extension): narrow durable deletion payload assertions [S24] |
| 51 | S24 | [2551ccfab394](https://github.com/WhitenWhiten/colp/commit/2551ccfab3949b182fa12ccf6fb925cfeae7ebfb) | fix(extension): narrow reviewed authority before rejoining excluded roots [S24] |
| 52 | S09 | [551e556a84c1](https://github.com/WhitenWhiten/colp/commit/551e556a84c1f1f5b5d192d247d4e87482626652) | fix(extension): fence resumed rejoin order against newer user actions (S09) |
| 53 | S09 | [c1bc65935118](https://github.com/WhitenWhiten/colp/commit/c1bc659351183b9348b2a820316022c4cf3204cc) | test(extension): preserve manual edits beside standalone rejoin echoes (S09) |
| 54 | S09 | [4a3d99ddbe54](https://github.com/WhitenWhiten/colp/commit/4a3d99ddbe54f8d9f59160bba382f3216074891d) | feat(extension): complete explicit paused-sync choices through options and worker [S09] |
| 55 | S22 | [86fc236e3d10](https://github.com/WhitenWhiten/colp/commit/86fc236e3d103cc8555068c2152f141d7d283158) | ci(extension): require the paused-delete restart journey [S22] |
| 56 | S25 | [534bddc4e9e1](https://github.com/WhitenWhiten/colp/commit/534bddc4e9e10fc0b144d5f92c84515d7f05be9f) | fix(extension): localize counted local-only bookmark disclosure [S25] |
| 57 | S22 | [3ecd35a4f791](https://github.com/WhitenWhiten/colp/commit/3ecd35a4f791600a719c2a09604bfecfb80efe5d) | [S22] Verify real options decision reads with isolated page setup |
| 58 | S24 | [16a09bc3282b](https://github.com/WhitenWhiten/colp/commit/16a09bc3282b655a392ca2c4bd53fbdea6cf3fd8) | test(extension): fence range UI owners across lost replies and reopen [S24] |
| 59 | S24 | [ef98371b49b9](https://github.com/WhitenWhiten/colp/commit/ef98371b49b913ddad41139fcfefdc8f4089db3b) | test(extension): resume default folders only from durable native receipts [S24] |
| 60 | S09 | [334194061719](https://github.com/WhitenWhiten/colp/commit/3341940617194e914b6be0fe95cdb1eaf3520927) | fix(extension): keep resolved history from hiding new sync issues [S09] |
| 61 | S22 | [a7719218002b](https://github.com/WhitenWhiten/colp/commit/a7719218002bc694ae3bae46764fadb43cdc391f) | ci(extension): cover every audited sync owner with four metric floors [S22] |
| 62 | S09 | [3eacfd067969](https://github.com/WhitenWhiten/colp/commit/3eacfd067969602d87acf0d515072d5abcb4d5ea) | fix(extension): recheck order before native rejoin move [S09][R2] race |
| 63 | S13 | [25a02b864ac4](https://github.com/WhitenWhiten/colp/commit/25a02b864ac4a5e3c24e8cb1c9fe76329a624a0a) | fix(server): retain URL metadata provenance through sync merges [S13][R2] |
| 64 | S09 | [f6aaedf7d8d5](https://github.com/WhitenWhiten/colp/commit/f6aaedf7d8d5088554237a5076cd434a9e79024f) | fix(extension): fence native restore identity handoff [S09][R2] race |
| 65 | S24 | [205b798bc7eb](https://github.com/WhitenWhiten/colp/commit/205b798bc7eb894ce0f00dfed36fa0bc9e422de9) | fix(extension): bound range enqueue dependency reads [S24][R2] |
| 66 | S15 | [fd11b9befe02](https://github.com/WhitenWhiten/colp/commit/fd11b9befe02db517d2852ef2c3de2d2bae43811) | fix(server): resolve bookmark metadata with the selected URL [S15][R2] |
| 67 | S22 | [dec02802ef14](https://github.com/WhitenWhiten/colp/commit/dec02802ef1482cc5b13694fd11a661c036a8f2f) | fix(extension): register boundary decision failure policies [S22][R2] |
| 68 | S22 | [ddd995d773e9](https://github.com/WhitenWhiten/colp/commit/ddd995d773e92e66612e051934a19d0dc594c255) | ci(extension): cover indexed enqueue owner [S22][R2] |
| 69 | S02, S22 | [e61a578c32f3](https://github.com/WhitenWhiten/colp/commit/e61a578c32f32f28bdc999c54d8c3b20beeef760) | test(extension): retain boundary journal in legacy upgrade expectations [S02][S22][R2] |
| 70 | S12 | [b9ba7fff95d0](https://github.com/WhitenWhiten/colp/commit/b9ba7fff95d099ef4c6cc9ea9581b56f7a95d651) | test(extension): exercise codec isolation with supported ingress [S12][R2] |
| 71 | S21 | [26bda3afd487](https://github.com/WhitenWhiten/colp/commit/26bda3afd487b833c707394a25b2f102c3d0f6b5) | fix(extension): surface consumed rejected edits consistently [S21][R2] |
| 72 | S15 | [4718bdf820ad](https://github.com/WhitenWhiten/colp/commit/4718bdf820ad76bf0134b73a4c5ddac8f4732992) | test(server): guard locked conflict decisions and admission CAS [S15][R2] |
| 73 | S24 | [73cb41d1c52d](https://github.com/WhitenWhiten/colp/commit/73cb41d1c52d90999b5cc744e84c2710800b0df3) | test(extension): verify frozen range authority through handlers [S24][R2] |
| 74 | S05, S22 | [c138b3c1d248](https://github.com/WhitenWhiten/colp/commit/c138b3c1d248f73a4db13f869feedbf68ea25a44) | test(server): isolate durable managed and Pull scenarios [S05][S22][R2] |
| 75 | S05, S09 | [f4278b9a1439](https://github.com/WhitenWhiten/colp/commit/f4278b9a143925532b9d25fa9124b8dce191bdfe) | fix(extension): preserve all unsettled rejoin intent across history [S05][S09][R2] |
| 76 | S24 | [8bd6397b1e45](https://github.com/WhitenWhiten/colp/commit/8bd6397b1e45f9fb41de62fc9f9abbbc83d10411) | test(extension): exercise range mount resolution through runtime [S24][R2] |
| 77 | S02 | [d311bf806d96](https://github.com/WhitenWhiten/colp/commit/d311bf806d96f44a8e987f28bc688018de5b48c3) | test(extension): recover first-run root authority through handlers [S02][R2] |
| 78 | S22 | [a3f05a385df7](https://github.com/WhitenWhiten/colp/commit/a3f05a385df76d4d84c18794b282cb612526194f) | ci(extension): build web product for recovery journeys [S22][R2] |
| 79 | S05, S15 | [0eb4d84e1273](https://github.com/WhitenWhiten/colp/commit/0eb4d84e127399f9e587a19609926482b6dba79e) | fix(server): fence conflict choices by current managed ancestry [S05][S15][R2] |
| 80 | S15 | [fa7edf99fd01](https://github.com/WhitenWhiten/colp/commit/fa7edf99fd01e933cdd72ab673a000af0a014979) | test(server): refresh managed conflict decisions before confirmation [S15][R2] |
| 81 | S03 | [947cb37a7f2d](https://github.com/WhitenWhiten/colp/commit/947cb37a7f2d8b6c5d5360e2c1ab8869864f2a19) | test(server): distinguish URL spelling from path and fragment identity [S03][R2] |
| 82 | S15 | [219815052c70](https://github.com/WhitenWhiten/colp/commit/219815052c7034647020cc5b1d66d06b8531ee8b) | test(server): authenticate historical recovery fixtures with their stored type [S15][R2] |
| 83 | S15 | [a2eb6c394a90](https://github.com/WhitenWhiten/colp/commit/a2eb6c394a9083b3857b0cf59496c1068f461a4d) | test(server): expose session authority failures before receipt replay [S15][R2] |
| 84 | S01 | [d45690b8b602](https://github.com/WhitenWhiten/colp/commit/d45690b8b6029a7fef84ab79462f550484e5f061) | fix(extension): authorize proven bootstrap containers at dispatch [S01][R2] |
| 85 | S24 | [32a120fa1ed9](https://github.com/WhitenWhiten/colp/commit/32a120fa1ed959150e4fdc6683b1d85f56163394) | test(extension): preserve stale range drafts without granting authority [S24][R2] |
| 86 | S22 | [9e4f7d9eca0d](https://github.com/WhitenWhiten/colp/commit/9e4f7d9eca0d80e045349838acfc93f16ff2c5e4) | fix(extension): persist installation before opening options [S22][R2] |
| 87 | S09 | [273a9f410f33](https://github.com/WhitenWhiten/colp/commit/273a9f410f33f18733761ec433b1a64b84ca8e8a) | test(extension): exercise paused Pull through rejoin native wrapper [S09][R2] |
| 88 | S15 | [32e3afb34130](https://github.com/WhitenWhiten/colp/commit/32e3afb3413072d2d3c8e7c6745be7d48c310bdd) | fix(web): preserve and explain unavailable conflict choices [S15][R2] |
| 89 | S05, S15 | [283dd7f5bb2a](https://github.com/WhitenWhiten/colp/commit/283dd7f5bb2a08d2dd6eab00da347437ccd71356) | fix(server): return explicit permission refusals for read-only conflict choices [S05][S15][R2] |
| 90 | S22 | [27792bc397e7](https://github.com/WhitenWhiten/colp/commit/27792bc397e7fecb519be4eee127931469b1000d) | test(extension): isolate install setup and type runtime probes [S22][R2] |
| 91 | S01 | [1e0faa177925](https://github.com/WhitenWhiten/colp/commit/1e0faa17792528d324a0c8c0215079c18e01556f) | test(extension): seed outbound faults through real native capture [S01][R2] |
| 92 | S15 | [8fca41d0a959](https://github.com/WhitenWhiten/colp/commit/8fca41d0a959f26d92f72f33c630b568dde4bfce) | fix(web): describe missing conflict context without implying deletion [S15][R2] |
| 93 | S13 | [6c9cecf1fe4b](https://github.com/WhitenWhiten/colp/commit/6c9cecf1fe4bc79636757c1a275a2536a0a1fcf4) | fix(server): retain metadata-only URL context through conflict decisions [S13][R2] |
| 94 | S01 | [858adc1ceb13](https://github.com/WhitenWhiten/colp/commit/858adc1ceb13baf4170fff9ab6fa20d65d4ad238) | fix(extension): bind advanced dispatch to confirmed plan authority [S01][R2] |
| 95 | S22 | [72f169dddbc7](https://github.com/WhitenWhiten/colp/commit/72f169dddbc7669002d84f48b61b14864fbd64d3) | test(extension): review explicit advanced first-run scope [S22][R2] |
| 96 | S17, S19 | [39a265d65b4f](https://github.com/WhitenWhiten/colp/commit/39a265d65b4f416aa12f6c3a5e14dba0b5613dbd) | fix(extension): invalidate first-run review on unavailable roots [S17][S19][R2] |
| 97 | S22 | [d82d9e347b10](https://github.com/WhitenWhiten/colp/commit/d82d9e347b10abc5678270494af2f33bdeb8fb04) | ci(server): collect current sync audit coverage with real PostgreSQL evidence [S22][R2] |
| 98 | S22 | [1d26ae1b3fc0](https://github.com/WhitenWhiten/colp/commit/1d26ae1b3fc0cde1f4269fa4ee92ebd3506070c8) | test(extension): cover first-run user actions through the page controller [S22][R2] |
| 99 | S11 | [d8df9f4b49e5](https://github.com/WhitenWhiten/colp/commit/d8df9f4b49e5ddd413e8bb49f4ab61a2c58146f1) | test(server): retain empty bookmark titles through Snapshot Pull and replay [S11][R2] |
| 100 | S22 | [df85a9dd7d75](https://github.com/WhitenWhiten/colp/commit/df85a9dd7d75f63fd9adaa003eda7c3ddd675758) | ci(extension): require server audit coverage for release [S22][R2] |
| 101 | S09 | [f09a6bf5aa64](https://github.com/WhitenWhiten/colp/commit/f09a6bf5aa64ea0c575e3299ee8c1f00fa4dba66) | [S09][R2] race-check rejoin native mutations and projection commits |
| 102 | S22 | [7beb89bc1021](https://github.com/WhitenWhiten/colp/commit/7beb89bc10214ff6324040ce9e6e9375f3bb333f) | test(extension): cover transport leases sibling order and release guards [S22][R2] |
| 103 | S22 | [a3a4325b8578](https://github.com/WhitenWhiten/colp/commit/a3a4325b8578b1561a2afeb4d4776afa3a7339cf) | test(extension): exercise auth entry through HTTP and durable authority [S22][R2] |
| 104 | S15, S22 | [58e7b82c7b23](https://github.com/WhitenWhiten/colp/commit/58e7b82c7b2349f77497158e576cd0691473b82b) | test(server): separate conflict replay from Product recovery invalidation [S15][S22][R2] |
| 105 | S01 | [0be954f766e4](https://github.com/WhitenWhiten/colp/commit/0be954f766e48e41ce567bd5c745cb74910dd070) | [S01][R2] bind advanced update and move payloads to confirmed steps |
| 106 | S22 | [5a229309507e](https://github.com/WhitenWhiten/colp/commit/5a229309507e452b62ba5730e3ac199501971733) | test(extension): exercise guarded native rejoin admission [S22][R2] |
| 107 | S22 | [3fa8e4a48824](https://github.com/WhitenWhiten/colp/commit/3fa8e4a48824de498913b32a7ceddf49a1e1eb16) | [S22][R2] Preserve extension coverage reports after failing tests |
| 108 | S11 | [b9e8cf49421d](https://github.com/WhitenWhiten/colp/commit/b9e8cf49421d6550980c0cbbcbcf05df946f7b1a) | test(server): grant bootstrap authority to empty-title Snapshot fixture [S11][R2] |
| 109 | S22 | [9a9f8d98ad9e](https://github.com/WhitenWhiten/colp/commit/9a9f8d98ad9e753719bad7640c759e99089de4cb) | test(extension): require real background completion and logout cleanup [S22][R2] |
| 110 | S22 | [1087f704a28f](https://github.com/WhitenWhiten/colp/commit/1087f704a28f9f9c89a22929868df43d93d04c1a) | test(extension): enforce worker message authority and bounds [S22][R2] |
| 111 | S22 | [5772795fe3e2](https://github.com/WhitenWhiten/colp/commit/5772795fe3e2fe47c18b0949baa96f839dc37a24) | [S22][R2] Fence stale server edition responses to their page render |
| 112 | S22 | [af8e6396b50c](https://github.com/WhitenWhiten/colp/commit/af8e6396b50c03da105fca1766a658d8b2469314) | [S22][R2] Fail bootstrap CLI checks on subprocess launch errors |
| 113 | S22 | [d3f8ffb8dfdc](https://github.com/WhitenWhiten/colp/commit/d3f8ffb8dfdc23f19883ecd144671cba2dd3d99c) | [S22][R2] Share concurrent public manifests and exercise real options entry |
| 114 | S22 | [1b1759a93def](https://github.com/WhitenWhiten/colp/commit/1b1759a93def46845b09c341c7984ff1fd4250c0) | [S22][R2] Require real CLI rejection evidence in negative baseline cases |
| 115 | S22 | [a64673de0c7c](https://github.com/WhitenWhiten/colp/commit/a64673de0c7cc9ca4ae1336e1b04fc9129fa8c02) | [S22][R2] Read optional permission from the reloaded options document |
| 116 | S22 | [aab0521107ad](https://github.com/WhitenWhiten/colp/commit/aab0521107adcf2d8bfe69f9c9fcd8847f08948d) | [S22][R2] Retain failed Playwright evidence for browser acceptance gates |
| 117 | S22 | [6cff0274d5fe](https://github.com/WhitenWhiten/colp/commit/6cff0274d5fe798290c5b4f38bce266835a18b55) | [S22][R2] Assert the actual singular advanced preview match count |
| 118 | S09 | [52ee36af9a09](https://github.com/WhitenWhiten/colp/commit/52ee36af9a0901eaef805d1c31b63105e6fc2630) | [S09][R2] race-check complete rejoin deletion evidence |
| 119 | S22 | [c0f3ff6f839a](https://github.com/WhitenWhiten/colp/commit/c0f3ff6f839a743b13ff62991658d1551af673f0) | test(extension): prove exact replay across terminal compaction [S22][R2] |
| 120 | S22 | [a3ab7a05313d](https://github.com/WhitenWhiten/colp/commit/a3ab7a05313df4c1e36b23d5ce7c3cd7070d4573) | test(server): ratchet current audit owners from passing PostgreSQL coverage [S22][R2] |
| 121 | S22 | [83c7b770fbd9](https://github.com/WhitenWhiten/colp/commit/83c7b770fbd924f250553b546794f89b64621445) | [S22][R2] Capture readonly sync state at failing browser stages |
| 122 | S22 | [4946eaadb229](https://github.com/WhitenWhiten/colp/commit/4946eaadb2290ba893ab9e9dd0d6b643d8eee0b2) | test(extension): expose metadata reset recovery stages and durable evidence [S22][R2] |
| 123 | S01 | [8377ddfb070c](https://github.com/WhitenWhiten/colp/commit/8377ddfb070c92a56a2c1094d7a3dcb2ca5ec524) | [S01][R2] Match selected subfolders inside their proved canonical container |
| 124 | S17 | [23c1e70488d3](https://github.com/WhitenWhiten/colp/commit/23c1e70488d34685cb5489557aa492290e7ce9bd) | [S17][R2] Preserve inherited managed boundaries in root previews and confirmation |
| 125 | S22 | [501457c74ef0](https://github.com/WhitenWhiten/colp/commit/501457c74ef03a1e7f5cc3510bda8da92d9a5b84) | [S22][R2] Exercise permission denial through the real grant helper |
| 126 | S22 | [ff8eff384a2b](https://github.com/WhitenWhiten/colp/commit/ff8eff384a2b3d8dac16b5f7d806a74056026635) | test(extension): verify bookmark worker authority and recovery entry points [S22][R2] |
| 127 | S01 | [a6fd3abf9d07](https://github.com/WhitenWhiten/colp/commit/a6fd3abf9d0769f52e4432609e2fe705d364541d) | [S01][R2] Preserve every explicit bootstrap identity before matching |
| 128 | S01 | [0f73e7551be0](https://github.com/WhitenWhiten/colp/commit/0f73e7551be0f4ad165254484b5afccabc72485e) | [S01][R2] Reject competing explicit native identity claims |
| 129 | S22 | [d9e3a26883e6](https://github.com/WhitenWhiten/colp/commit/d9e3a26883e62848ed2a780863f569c36556ab02) | [S22][R2] Retain frozen replica facts in browser failure evidence |
| 130 | S09 | [c47573bacfeb](https://github.com/WhitenWhiten/colp/commit/c47573bacfebef58ba680a32dc784c08416a00ec) | [S09][R2] define remote deletion review contract |
| 131 | S09 | [4e6c52380ef2](https://github.com/WhitenWhiten/colp/commit/4e6c52380ef2cd9554e8858619c7efae008923fb) | [S09][R2] delete only authorized rejoin members without recursion |
| 132 | S22 | [7da284e75544](https://github.com/WhitenWhiten/colp/commit/7da284e75544bad37ed6a6cb113fc7238f7ff6e6) | [S22][R2] validate replay receipt batches against real server envelopes |
| 133 | S01 | [3f170e9dddac](https://github.com/WhitenWhiten/colp/commit/3f170e9dddaca17271173914f837f1e0ae25499d) | [S01][R2] Preserve mounted canonical ancestry through advanced bootstrap |
| 134 | S09 | [38d83bf8ab13](https://github.com/WhitenWhiten/colp/commit/38d83bf8ab132bce30b1b4a28bff7a0a50dc68eb) | [S09][R2] scope range-exit exclusions to retained native copies |
| 135 | S22 | [28100beba8ba](https://github.com/WhitenWhiten/colp/commit/28100beba8badc186d18c3292c62b6253a078f49) | [S22][R2] Assert current root coverage and durable command identities |
| 136 | S05, S22 | [953e3041e942](https://github.com/WhitenWhiten/colp/commit/953e3041e94247401c31f67cca3878f2e35b3e3f) | [S05/S22][R2] authorize explicit retirement with current account and installation proof |
| 137 | S01 | [26b91367def0](https://github.com/WhitenWhiten/colp/commit/26b91367def05d41550a741223eed87becb68588) | [S01][R2] Preserve selected subfolder identity through Pull echoes |
| 138 | S22 | [86298634b3c3](https://github.com/WhitenWhiten/colp/commit/86298634b3c3395d1ed1f6160caa553235df6b07) | [S22][R2] Distinguish deferred Push envelopes from terminal receipts |
| 139 | S22 | [e9f2b0c21dd3](https://github.com/WhitenWhiten/colp/commit/e9f2b0c21dd326fcec03e87d795981aa233a25f3) | [S22][R2] Assert contradictory custom mount identities fail closed |
| 140 | S22 | [ed59812316ac](https://github.com/WhitenWhiten/colp/commit/ed59812316ace45f6a686d635a4a6a49153393de) | [S22][R2] Isolate irreversible security epoch retirement fixtures |
| 141 | S22 | [a914e219052a](https://github.com/WhitenWhiten/colp/commit/a914e219052a297fd9d8fc04411ea4fa7603b774) | [S22][R2] Verify boundary authority and shared confirmation receipts |
| 142 | S22 | [fbdbf76b38ec](https://github.com/WhitenWhiten/colp/commit/fbdbf76b38ec7fe9e43804c35ee3f26bd6368942) | [S22][R2] Cover root and advanced authority entry behavior |
| 143 | S09 | [789cb6c5c8bb](https://github.com/WhitenWhiten/colp/commit/789cb6c5c8bb4ac0896f507ab9125969867612c0) | [S09][R2] resolve remote tombstones with explicit subtree choices |
| 144 | S05 | [be741d0dbbee](https://github.com/WhitenWhiten/colp/commit/be741d0dbbee6314c34d402b154b369b6df58972) | [S05][R2] Recover opted-out unknown uploads through durable server retirement |
| 145 | S22 | [e4ca57944446](https://github.com/WhitenWhiten/colp/commit/e4ca57944446d0918e945f208def5770d1450d0d) | [S22][R2] Require retirement and remote deletion owner coverage |
| 146 | S22 | [34a497ac185f](https://github.com/WhitenWhiten/colp/commit/34a497ac185fac99eb6e4115030cd76cd3ea683d) | [S22][R2] Gate retirement reauthorization owner with real PostgreSQL coverage |
| 147 | S01 | [b2ec6f9f6550](https://github.com/WhitenWhiten/colp/commit/b2ec6f9f6550d5fee8b1f37266bcc79ead64942d) | [S01][R2] Bind first-run mount echoes to durable confirmation proof |
| 148 | S05 | [bf214ebafc9a](https://github.com/WhitenWhiten/colp/commit/bf214ebafc9a6054b04b325df94663da0f5b5e13) | [S05][R2] Bind reset completion proof to the exact stored operation |
| 149 | S09 | [4b607549eaa9](https://github.com/WhitenWhiten/colp/commit/4b607549eaa93a60e532475a3395776335254a9b) | [S09][R2] Bound queue history reads without dropping pending edits |
| 150 | S09 | [f71c7c2e24a5](https://github.com/WhitenWhiten/colp/commit/f71c7c2e24a51a426e043d26c44d96e40072bcf3) | [S09][R2] Read pending reset capability before offering recovery |
| 151 | S09 | [712dd57bfdd2](https://github.com/WhitenWhiten/colp/commit/712dd57bfdd256568106bf1eb2d7619e1bdfc19f) | [S09][R2] Expose confirmed browser choices for cloud deletions |
| 152 | S01 | [ffefe20a1b85](https://github.com/WhitenWhiten/colp/commit/ffefe20a1b85854ec5ec470588e7814cfa171d65) | [S01][R2] Read current upload boundary identities without scanning the library |
| 153 | S09 | [ea420709487d](https://github.com/WhitenWhiten/colp/commit/ea420709487d3b28c5434fc16c6aeeb213c72daa) | [S09][R2] Exercise browser deletion decisions through DOM and runtime |
| 154 | S04, S14 | [67f00644d9a6](https://github.com/WhitenWhiten/colp/commit/67f00644d9a6f371ab032a7118f8e5270b3b6cce) | [S04/S14][R2] Preserve independent extension namespaces in local projections |
| 155 | S01 | [45c1db1f1b9d](https://github.com/WhitenWhiten/colp/commit/45c1db1f1b9dc3a857f15bded3030c0b8afca126) | [S01][R2] Reject missing private identities at the final upload boundary |
| 156 | S05 | [30f994e5e480](https://github.com/WhitenWhiten/colp/commit/30f994e5e4806bf0e367f97379c07cf9809d4639) | [S05][R2] Keep resumed Reset previews accurate across queue pages |
| 157 | S09 | [3b56e8b0af16](https://github.com/WhitenWhiten/colp/commit/3b56e8b0af165a8685c9a000f99dec2a80237e70) | [S09][R2] Await the final cloud placement before reviewing Keep cloud |
| 158 | S09 | [9ed9f50471fe](https://github.com/WhitenWhiten/colp/commit/9ed9f50471fea6c530ef20d4b24df53af167f071) | [S09][R2] Preserve deletion consent only for unchanged decisions |
| 159 | S22 | [669692c45da9](https://github.com/WhitenWhiten/colp/commit/669692c45da910cda6021708129593c9e83f6f2e) | [S22][R2] Verify profile isolation through native root authority |
| 160 | S22 | [ae7a21d5f2e8](https://github.com/WhitenWhiten/colp/commit/ae7a21d5f2e898842b2743190714861867bf7e39) | [S22][R2] Exercise metadata, restore and durable recovery boundaries |
| 161 | S09 | [6adfb21c7987](https://github.com/WhitenWhiten/colp/commit/6adfb21c798700e874700347c43c41b6b4dc0e60) | [S09][R2] Cover rejected authority and interrupted rejoin recovery |
| 162 | S22 | [7b823f1c589e](https://github.com/WhitenWhiten/colp/commit/7b823f1c589e9c24181b61393e36fa55bed44118) | [S22][R2] Recover online wakes after failed authority admission |
| 163 | S09 | [32c4a1589912](https://github.com/WhitenWhiten/colp/commit/32c4a1589912ca1648ce62a98c12a9f3817ae996) | [S09][R2] Trace Keep cloud completion states without bookmark payloads |
| 164 | S22 | [1055b396e5d6](https://github.com/WhitenWhiten/colp/commit/1055b396e5d692d018c5c66bc434f845c463a61a) | [S22][R2] Capture profile root authority before browser assertions |
| 165 | S22 | [46acd20d65c1](https://github.com/WhitenWhiten/colp/commit/46acd20d65c1e3cf81f1b8cbc1ed2baba5096014) | [S22][R2] Cover real worker admission, messages and recovery events |
| 166 | S09 | [64fb90db7066](https://github.com/WhitenWhiten/colp/commit/64fb90db7066224348d1d6c6507b65c2244691de) | [S09][R2] Resume and atomically finish a completed rejoin after restart |
| 167 | S22 | [1d55b181549b](https://github.com/WhitenWhiten/colp/commit/1d55b181549b571b543897339e560fef22565b27) | [S22][R2] Gate ingress, metadata, repair, and rejoin placement owners |
| 168 | S09 | [3d1833171de3](https://github.com/WhitenWhiten/colp/commit/3d1833171de31bbc57ca72b56ffb140eb0859928) | [S09][R2] Refresh decision consent when another page changes language |
| 169 | S09 | [cdb4c308cb41](https://github.com/WhitenWhiten/colp/commit/cdb4c308cb41c9929807faead6203924d46d51ed) | [S09][R2] Retire an obsolete deletion review with its actual removal |
| 170 | S09 | [d147f20c8444](https://github.com/WhitenWhiten/colp/commit/d147f20c84446e20fe78ab501ddc71f237616456) | [S09][R2] Verify current placement evidence for offline moves |
| 171 | S22 | [49bec3df3bc4](https://github.com/WhitenWhiten/colp/commit/49bec3df3bc46b08c5a650ecb519082d151fdbe8) | [S22][R2] Exercise first-run and range authority through durable entry points |
| 172 | S01 | [37e44937b69f](https://github.com/WhitenWhiten/colp/commit/37e44937b69f78a28e982566c4bda5947c4e4a0e) | [S01][R2] Limit Snapshot creates to the confirmed mounted subtree |
| 173 | S22 | [1cad935eaccf](https://github.com/WhitenWhiten/colp/commit/1cad935eaccff764d31d89f295a204bb6017e62f) | [S22][R2] Remove extra EOF blank lines from audit fixtures |
| 174 | S01, S10 | [43689b7c3954](https://github.com/WhitenWhiten/colp/commit/43689b7c395428272ab8e4efcb2c781711ce060f) | [S01][S10][R2] Recover complete Snapshots within each confirmed mount |
| 175 | S01 | [10dbc218d629](https://github.com/WhitenWhiten/colp/commit/10dbc218d629cde086f549bb8fc4cfac6fa2c898) | [S01][R2] Recheck each upload batch with coherent current boundary facts |
| 176 | S01, S24 | [0692248216fa](https://github.com/WhitenWhiten/colp/commit/0692248216fad931b6febde329e2163c0fcd80b0) | [S01][S24][R2] Reproduce Snapshot native authority drift after planning |
| 177 | S01, S24 | [530c0995958c](https://github.com/WhitenWhiten/colp/commit/530c0995958c72bf59b0c70de63bfd964a0ac944) | [S01][S24][R2] Recheck native Snapshot authority before create and delete |
| 178 | S22 | [8320307b41e6](https://github.com/WhitenWhiten/colp/commit/8320307b41e6ed0f8cd05a2269684916fb803967) | [S22][R2] Verify profile isolation through current preview authority |
| 179 | S22 | [4e2fea30b79a](https://github.com/WhitenWhiten/colp/commit/4e2fea30b79aafe3f262e2a4da42ec2d7634669f) | [S22][R2] Gate final native and batch boundary owners at four metrics |
| 180 | S12, S15 | [36d2f7876153](https://github.com/WhitenWhiten/colp/commit/36d2f78761534552d01c252cafe8ce86291452a7) | test(sync): reproduce custom conflict title contract mismatch |
| 181 | S11 | [1f332bd40c44](https://github.com/WhitenWhiten/colp/commit/1f332bd40c44be0dbea6f833b990e4ba0a1cbccc) | [S11][R4] Permit empty bookmark titles in Web conflict resolution |
| 182 | S12 | [dbf4a0b96bf8](https://github.com/WhitenWhiten/colp/commit/dbf4a0b96bf845513af1a6b297c39fd6ffa91ec8) | [S12][R4] Share title code-unit and UTF-8 limits with Web conflict forms |
| 183 | S02, S17, S24 | [f1c056646cd5](https://github.com/WhitenWhiten/colp/commit/f1c056646cd5a8a2de76b31516c2560cd126ea1c) | [review][R4] Prove durable range confirmation fails on worker cache loss |
| 184 | S24 | [1fe8d55b14dc](https://github.com/WhitenWhiten/colp/commit/1fe8d55b14dcc8fedced8950724915b07ec170ac) | [S24][R4] Resolve reviewed range refs after worker restart |
| 185 | S22 | [758519c432dd](https://github.com/WhitenWhiten/colp/commit/758519c432dd464c52787e6fec0a1c00b548f9ce) | [S22][R4] Model confirmed Snapshot download authority in fixtures |
| 186 | S05, S10 | [cbec859485fa](https://github.com/WhitenWhiten/colp/commit/cbec859485fac246183c89a90ec97cb6eb5d654e) | [S05][S10][R4] Validate retained rebuild identity before restoring or registering |
| 187 | S22 | [bd2f88f8688b](https://github.com/WhitenWhiten/colp/commit/bd2f88f8688bee4d41bd71364e06f13f8db25431) | [S22][R4] Preserve confirmed authority across interrupted Snapshot tests |
| 188 | S09 | [d9ee367695e8](https://github.com/WhitenWhiten/colp/commit/d9ee367695e838ddcca633c144f8746451e71aa3) | [S09][R4] Reproduce stale rejoin writes inside production native guards |
| 189 | S09 | [aaa4d763c761](https://github.com/WhitenWhiten/colp/commit/aaa4d763c76182d0a1a8b5fbb1f6c115c5d51d42) | [S09][R4] Reproduce stale remove move order and restore through native wrappers |
| 190 | S01, S07 | [73d99f56d45c](https://github.com/WhitenWhiten/colp/commit/73d99f56d45c8f1342e68dd990d07fa483d45e95) | [review][R4] Prove Snapshot native guard expires inside real browser wrapper |
| 191 | S09 | [1310b15063fd](https://github.com/WhitenWhiten/colp/commit/1310b15063fda0f667f21d9deb01d8142b2e9888) | [S09][R4] Recheck frozen rejoin authority at the native write boundary |
| 192 | S08 | [f7b74f2d9b01](https://github.com/WhitenWhiten/colp/commit/f7b74f2d9b014258781c49de8659ece725664550) | [S08][R4] Batch Pull state-index reads without truncating history |
| 193 | S22 | [60cd8c8261e9](https://github.com/WhitenWhiten/colp/commit/60cd8c8261e9e889d33238cd5945f3588d5af151) | [S22][R4] Gate late native-call admission as coverage owner 158 |
| 194 | S22 | [848bb51463dd](https://github.com/WhitenWhiten/colp/commit/848bb51463dd14041244de8a36111d43f8a354e7) | [S22][R4] Exercise acknowledged Snapshot repair through the engine |
| 195 | S08 | [870fdc3791b6](https://github.com/WhitenWhiten/colp/commit/870fdc3791b62d8569f315e7d1044ce4bb073bcb) | [S08][R4] Read mapping content only for current open sync issues |
| 196 | S01 | [4dac891e5c68](https://github.com/WhitenWhiten/colp/commit/4dac891e5c685851591e94b57b06db6f067cdf96) | [S01][R4] Preserve Snapshot native checks through final adapter admission |
| 197 | S08 | [0f1114c12445](https://github.com/WhitenWhiten/colp/commit/0f1114c124450019285737d50604a7dc274525db) | [S08][R4] Load Pull issue ancestry only for current dependencies |
| 198 | S05, S24 | [8ba0906c5231](https://github.com/WhitenWhiten/colp/commit/8ba0906c5231299a2b372fb4c36dcedf0b97343b) | test(sync): independently verify archived rebuild through runtime Session lane |
| 199 | S01, S07 | [c12faa2a5d37](https://github.com/WhitenWhiten/colp/commit/c12faa2a5d37315a8ef3f83e787d44b583ee2723) | [S01][S07][R4] Reproduce ordinary Pull writes after native admission changes |
| 200 | S07 | [566ebac13792](https://github.com/WhitenWhiten/colp/commit/566ebac137920982628dce46a9fa716d8ccd8efb) | [S07][R4] Preserve Pull content preimages through final native admission |
| 201 | S01 | [a8ad55cc47b3](https://github.com/WhitenWhiten/colp/commit/a8ad55cc47b3a8dfb2179d19a2786b8cb9963973) | [S01][R4] Validate queued content at the actual network dispatch boundary |
| 202 | S22 | [6897e60f0759](https://github.com/WhitenWhiten/colp/commit/6897e60f075925a11941d7c681ad7f611c737150) | [S22][R4] Verify Pull native admission through the production adapter |
| 203 | S01, S07 | [05e083e5aaf8](https://github.com/WhitenWhiten/colp/commit/05e083e5aaf8399beeb690f26dde98aa0d96fd07) | [S01][S07][R4] Revalidate persisted Pull placement at native admission |
| 204 | S22 | [429cbf5184a0](https://github.com/WhitenWhiten/colp/commit/429cbf5184a0b6ee4f52d03b4dd65a8aa6127834) | [S22][R4] Gate shared native and transport authority owners |
| 205 | S01, S07 | [7a830d42b9c0](https://github.com/WhitenWhiten/colp/commit/7a830d42b9c027339c127ba1325e33d11b19879d) | [S01][S07][R4] Guard each Pull delete after native admission |
| 206 | S01, S24 | [125d37769610](https://github.com/WhitenWhiten/colp/commit/125d37769610622ed60c167a7181dc5693095a99) | [S01][S24][R4] Reproduce Snapshot delete after local admission changes |
| 207 | S01, S24 | [bc17aa96a855](https://github.com/WhitenWhiten/colp/commit/bc17aa96a855870f1ed00ed67e3a11d749a4815e) | [S01][S24][R4] Preserve local Snapshot delete preimages at native admission |
| 208 | S22 | [7fdae3fd9ac6](https://github.com/WhitenWhiten/colp/commit/7fdae3fd9ac6a9f29554c35b650b202368cd457e) | [S22][R4] Exercise projection update failures on real child identities |
| 209 | S01, S07 | [90c9a68a9181](https://github.com/WhitenWhiten/colp/commit/90c9a68a9181bf6e3026c2c573bafa0bfceb8489) | [S01][S07][R4] Reproduce Pull create admission in private or excluded parents |
| 210 | S08 | [1d9d903aac8b](https://github.com/WhitenWhiten/colp/commit/1d9d903aac8bb00c4be716bed5820dfba72df814) | [S08][R4] Read fresh Pull issues without repeated adoption write locks |
| 211 | S07, S24 | [3d2524c03c21](https://github.com/WhitenWhiten/colp/commit/3d2524c03c21d8ca4e452a2629c6b2438a0232ad) | [S07][S24][R4] Separate confirmed native content from current Snapshot authority |
| 212 | S22 | [29e50693948b](https://github.com/WhitenWhiten/colp/commit/29e50693948bb3c0e63f901f30a64924efe6f132) | [S22][R4] Preserve native capabilities in the Snapshot wrapper fixture |
| 213 | S08 | [404a4c534c0a](https://github.com/WhitenWhiten/colp/commit/404a4c534c0a23fcdc69be20ab4489a329976ac9) | [S08][R4] Cover sparse diagnostic issue readers after parallelization |
| 214 | S22 | [4d2a1b57f841](https://github.com/WhitenWhiten/colp/commit/4d2a1b57f841ff7c05242f284249a50c1170eb42) | [S22][R4] Exercise and gate Pull worksets and real scope recovery |
| 215 | S07, S24 | [9a98d46a8d79](https://github.com/WhitenWhiten/colp/commit/9a98d46a8d79c6b36a8e323ba330bed0c44ea99e) | [S07][S24][R4] Honor current explicit delete confirmation after Snapshot holds |
| 216 | S05 | [5a677e71a5b4](https://github.com/WhitenWhiten/colp/commit/5a677e71a5b429ac950594e18850c04b7e4c792f) | [review][R4] Verify exact Snapshot-held subtree delete authority |
| 217 | S07 | [703f4a4ac007](https://github.com/WhitenWhiten/colp/commit/703f4a4ac007710b50cfa6ddefb2b822de585cb4) | [S07][R4] Reproduce item parking after refused native move |
| 218 | S07 | [e16cd6cc171a](https://github.com/WhitenWhiten/colp/commit/e16cd6cc171a9261f66bbc93b8c62db9a5cc1e35) | [S07][R4] Keep rejected native call phase consistent for item recovery |
| 219 | S01, S07 | [7d3e17ad6c08](https://github.com/WhitenWhiten/colp/commit/7d3e17ad6c084eca1de44128d9a6be6a65e76769) | [S01][S07][R4] Revalidate Pull create parents at final native admission |
| 220 | S22 | [bbd6df60f7e2](https://github.com/WhitenWhiten/colp/commit/bbd6df60f7e2b9e90deaf17a6768291acb66ab21) | [S22][R4] Cover Snapshot native resumption and gate six recovery owners |
| 221 | S21 | [880e37470347](https://github.com/WhitenWhiten/colp/commit/880e3747034754146015b5fbf8a35ca012a3a8b7) | [S21][R4] Restore Reset focus only for the canceled current view |
| 222 | S22 | [9e31becab142](https://github.com/WhitenWhiten/colp/commit/9e31becab1425fa02e3439ea6bfd0816056c54a3) | [S22][R4] Gate five executable bootstrap and recovery UI owners |
| 223 | S21 | [8e172c271ba0](https://github.com/WhitenWhiten/colp/commit/8e172c271ba03e0fccbea5b60add774c9be4071a) | [S21][R4] Describe native bookmark creation as unconfirmed |
| 224 | S22 | [cfd1294b25de](https://github.com/WhitenWhiten/colp/commit/cfd1294b25de8ea27b099b4ef6f2a698b407101b) | [S22][R4] Remove unused legacy Pull create recovery exports |
| 225 | S07 | [9155f59b96fa](https://github.com/WhitenWhiten/colp/commit/9155f59b96fae7d0a1f411c97618bc2989554334) | [S07][R4] Reproduce explicit binding of a materialized native wait |
| 226 | S07, S24 | [936e2d6736e0](https://github.com/WhitenWhiten/colp/commit/936e2d6736e0bf45fcb1c309907708e3aff80634) | [S07][S24][R4] Resume range-copy waits through the atomic identity handoff |
| 227 | S19, S22 | [b2d225897074](https://github.com/WhitenWhiten/colp/commit/b2d225897074457995874cdcf60fb9cab5bb64c2) | [S19][S22][R4] Expose observed native candidates for explicit Options confirmation |
| 228 | S17 | [15ee5dd66c91](https://github.com/WhitenWhiten/colp/commit/15ee5dd66c91263c9345fbb8302c54245e6eba49) | [S17][R4] Reproduce separator range materialization refusal |
| 229 | S21 | [003400a0a0e8](https://github.com/WhitenWhiten/colp/commit/003400a0a0e80b0e94e89346d48a27a1909cd208) | [S21][R4] Describe native wait cancellation without assuming absence |
| 230 | S07 | [d41f61ad379f](https://github.com/WhitenWhiten/colp/commit/d41f61ad379f834238605533c5fa2744eefb2768) | [S07][R4] Reproduce all exits for a lost range child create result |
| 231 | S07, S24 | [bb8fa40bb851](https://github.com/WhitenWhiten/colp/commit/bb8fa40bb85143af923afe625c4cda2738d9d0eb) | [S07][S24][R4] Recover child copy waits without borrowing parent receipts |
| 232 | S08 | [0083342435a2](https://github.com/WhitenWhiten/colp/commit/0083342435a256ae4391e74e1354d67531e45379) | [S08][R4] batch fresh bootstrap queue and receipt reads |
| 233 | S22 | [ee0aa23326d3](https://github.com/WhitenWhiten/colp/commit/ee0aa23326d33d76fa196e0e0b7f25f341f6beaf) | [S22][R4] Verify Pull create and restore adapter recovery facts |
| 234 | S22 | [0d117448dd5e](https://github.com/WhitenWhiten/colp/commit/0d117448dd5e05bf504d7d0b2eef0dd3f0ba411d) | [S22][R4] Gate coherent queue and receipt read repository |
| 235 | S17 | [fdb94d0d934b](https://github.com/WhitenWhiten/colp/commit/fdb94d0d934b243d994061f08e81f1502d657105) | [S17][R4] Preserve separator sidecars during independent range copies |
| 236 | S22 | [1695a096640c](https://github.com/WhitenWhiten/colp/commit/1695a096640c9d0e537f1ec1baa6c24401ec25fc) | [S22][R4] Gate native create restore and range adapters |
| 237 | S22 | [4d25330c43f0](https://github.com/WhitenWhiten/colp/commit/4d25330c43f0ce5ebb0ed49adfd3dce8d551ba40) | [S22][R4] Gate final native admission and materialization decisions |
| 238 | S01 | [926f1df3d4e0](https://github.com/WhitenWhiten/colp/commit/926f1df3d4e02664e37fb8303b2be129fd7922d1) | [S01][R5] Cover dual-anchor insertion with concurrent local reorder |
| 239 | S07 | [8a671c7d0b42](https://github.com/WhitenWhiten/colp/commit/8a671c7d0b428d89ba43e68af48523fb8acc44d1) | [S07][R5] Assert admission refusal phases and retained started evidence |
| 240 | S01 | [88a55e6218c8](https://github.com/WhitenWhiten/colp/commit/88a55e6218c8fefdc5a2006c8ee69b8ae5bf86d5) | [S01][R5] reproduce materialization echo identity loss through worker ingress |
| 241 | S01 | [3a2db5b4a78b](https://github.com/WhitenWhiten/colp/commit/3a2db5b4a78b7d1f0e1b8711aa387e3728e5a213) | [S01][R5] exercise child native wait across real Chromium worker stops |
| 242 | S12 | [457f1eb3cb32](https://github.com/WhitenWhiten/colp/commit/457f1eb3cb32f8233f8d9d78018390fd59de1d00) | [S12][R5] Reproduce conflict text byte limits through actual forms |
| 243 | S01, S07 | [567ee969c7d7](https://github.com/WhitenWhiten/colp/commit/567ee969c7d755808ccc3500a5a9e78dde6b341e) | [S01][S07][R5] Reproduce competing create callbacks through the registered worker |
| 244 | S12 | [7fe1c7f2abeb](https://github.com/WhitenWhiten/colp/commit/7fe1c7f2abeb2143669f955893ce3722f52e9de5) | [S12][R5] Reject oversized conflict fields before sending resolutions |
| 245 | S01, S06 | [4f72ff5a15d0](https://github.com/WhitenWhiten/colp/commit/4f72ff5a15d049be0dcb1d67e2a994b5f12da28f) | [S01][S06][R5] Preserve authoritative creates across competing native callbacks |
| 246 | S07 | [09f8dce77384](https://github.com/WhitenWhiten/colp/commit/09f8dce77384b5477f1eb5104d4bb75911df9849) | [S07][R5] Reproduce event-only create recovery binding an unconfirmed native |
| 247 | S07 | [6a4a32cb547f](https://github.com/WhitenWhiten/colp/commit/6a4a32cb547f8bc8be846144ddeb552646787a6b) | [S07][R5] Pin receipt priority and explicit confirmation after create interruption |
| 248 | S07 | [8916b57b1464](https://github.com/WhitenWhiten/colp/commit/8916b57b1464a77d7d82165f5093145f5214bb23) | [S07][R5] Require receipt or explicit confirmation when recovering observed creates |
| 249 | S01 | [996096c98aa0](https://github.com/WhitenWhiten/colp/commit/996096c98aa048e9b58cb158d308f3b384116d49) | [S01][R5] cover explicit child bind with late native echoes |
| 250 | S06, S07 | [f6d9eb9d8740](https://github.com/WhitenWhiten/colp/commit/f6d9eb9d8740cdaef2d8ceba3b81481b8140bddc) | [S06][S07][R5] Preserve user edits across receipt-before-mapping interruption |
| 251 | S22 | [99a7a44dc72a](https://github.com/WhitenWhiten/colp/commit/99a7a44dc72a28026851dda07b791b0c3599b050) | [S22][R5] Give Pull regression fixtures real parent authority |
| 252 | S22 | [199350a88a43](https://github.com/WhitenWhiten/colp/commit/199350a88a4315fb5f315f3bf63eaa7691bb8ed5) | [S22][R5] Keep recovery mount fixture parent edges consistent |
| 253 | S07 | [193a12dc328d](https://github.com/WhitenWhiten/colp/commit/193a12dc328dc20388c807c11df238172df12b8b) | [S07][R5] Preserve later local moves while advancing Pull authority |
| 254 | S07 | [fd209eb67719](https://github.com/WhitenWhiten/colp/commit/fd209eb677199b020d343db999c93beac6d59395) | [S07][R5] Test ordinary retry after a concurrent captured move |
| 255 | S08 | [064249d8645e](https://github.com/WhitenWhiten/colp/commit/064249d8645ecccae23176d9c08d878f0eb50ae8) | [S08][R5] Bound fresh Pull mapping reads without copying entire event histories |
| 256 | S08 | [92d701ae14b3](https://github.com/WhitenWhiten/colp/commit/92d701ae14b34a6f1a9e1f34d16c763b8c70f2d8) | [S08][R5] Read Pull shadows and durable mappings from one fresh transaction |
| 257 | S08 | [fa3eb293d684](https://github.com/WhitenWhiten/colp/commit/fa3eb293d6840b957cacd5b889c0fc0aef1183c0) | [S08][R5] Exercise mapping read budgets through 96 real worker receipts and Pull echoes |
| 258 | S08 | [7851a4768c9c](https://github.com/WhitenWhiten/colp/commit/7851a4768c9c50679125e3ce9a2bb19186cedf57) | [S08][R5] Preserve shadow suppression and publication guards across bounded reads |
| 259 | S08 | [dbd64f3cf704](https://github.com/WhitenWhiten/colp/commit/dbd64f3cf704483d81cfaef4f3f847ce459c474b) | [S08][R5] Compare readonly index names without narrowing the IDB string type |
| 260 | S22 | [fb4e81d2c3a8](https://github.com/WhitenWhiten/colp/commit/fb4e81d2c3a819aceecc0fab4a11484cce0c85ac) | [R5] Test queue persistence after response loss and import interruption |
| 261 | S07 | [464f92d80ad1](https://github.com/WhitenWhiten/colp/commit/464f92d80ad18ee0d48e4ac252805ec714da9f68) | [S07][R5] Keep concurrent move regression content unchanged |
| 262 | S07 | [bcac7f5988e9](https://github.com/WhitenWhiten/colp/commit/bcac7f5988e9149e90a34fb44e4c859e55ccb417) | [S07][R5] Readmit captured placement only after a proven native non-call |
| 263 | S22 | [95d2ff1842e5](https://github.com/WhitenWhiten/colp/commit/95d2ff1842e52906586f3f3534008982c3712f8b) | [S22][R5] Gate coherent Pull mapping reads as the 188th coverage owner |
| 264 | S07 | [c883c07e6867](https://github.com/WhitenWhiten/colp/commit/c883c07e68677c230c06ead41b333273bc729963) | [S07][R5] Make the conditional event read parse unambiguously |
| 265 | S07 | [ba426e7de833](https://github.com/WhitenWhiten/colp/commit/ba426e7de83302683840f5d24b6dd9b8105abb3a) | [S07][R5] Test captured rename while a refused move awaits retry |
| 266 | S07 | [f9c454ee60a7](https://github.com/WhitenWhiten/colp/commit/f9c454ee60a7bed064675b486e7e46d0c0d5f921) | [S07][R5] Preserve native non-call recovery across deletion and reopen |
| 267 | S07 | [fd6a05b377d2](https://github.com/WhitenWhiten/colp/commit/fd6a05b377d2ab804b5dafc00bbcf480956e0a30) | [S07][R5] preserve concurrent invocation facts at move call admission |
| 268 | S07 | [e75aafcc7f71](https://github.com/WhitenWhiten/colp/commit/e75aafcc7f718ccc61286ca2e71d815d2ebdb387) | [S07][R5] classify a competing move start as a retryable CAS |
| 269 | S07 | [0922c112bd64](https://github.com/WhitenWhiten/colp/commit/0922c112bd649f5e0ddf75d7ee6c319579359b86) | [S07][R5] preserve captured title and URL edits across move retries |


## 保留的既有 PR 分支历史

首次集成提交 a798a996 保留第二父分支的以下 5 个提交。它们不属于上表的本轮主线任务计数，但属于 Git 从 main 比较到 PR 的完整可达历史。源码提交 0922c112 的完整图差异因此为 274 个提交：本轮追踪的 269 个，加上这里保留的 5 个。后续报告及文档校正提交另计。

| 既有提交 | 原提交主题 |
|---|---|
| [807412864045](https://github.com/WhitenWhiten/colp/commit/80741286404568cd7e65218617f9ce3bed01c9a5) | fix(extension): reject unsuccessful range confirmations (#20) |
| [aadf11772860](https://github.com/WhitenWhiten/colp/commit/aadf11772860a9cdba9aacd820f9dd6f02d9f1f0) | chore(sync-audit): prepare reproducible offline validation workspace |
| [5627640bccba](https://github.com/WhitenWhiten/colp/commit/5627640bccba0cb248bda3126d528ee7b4d1742f) | chore(sync-audit): provision real PostgreSQL and Chromium test binaries |
| [13988261d6b4](https://github.com/WhitenWhiten/colp/commit/13988261d6b43c8bf066976fe00bd28a0b245d65) | chore(sync-audit): install lease-checked commit delivery |
| [88b8d2955cc4](https://github.com/WhitenWhiten/colp/commit/88b8d2955cc4bd717297ff04b097fffd449c2d68) | [S22] Remove three temporary audit workflows |
