# AeroCoreUpdate — AeroCore OTA Update Server

Server phát bản cập nhật cho fleet GCS/AIR, cài đặt đúng theo [`docs/update-server-api.md`](docs/update-server-api.md) (spec normative) và [`docs/update-server-openapi.json`](docs/update-server-openapi.json).

Node hỏi *"tôi là ai, đang chạy gì, thì nên chạy gì?"* — server trả lời bằng một manifest **ký Ed25519**. Nhờ node tự khai báo serial/platform/version, server làm được staged rollout, ghim serial vào một bản, hoặc chặn một bản lỗi mà không đụng tới fleet.

Kèm theo là **web UI quản trị** (đăng nhập JWT) để upload gói, đổi `latest`, tạm dừng rollout và theo dõi kết quả.

---

## Chạy nhanh

```bash
cp .env.example .env      # điền DB_PASSWORD, JWT_SECRET, UPDATE_API_KEYS
docker compose up -d --build
docker compose logs aerocoreupdate | head -30
```

Log khởi động in ra ba thứ cần lưu lại:
- **OTA public key (base64)** — nạp vào map `key_id → key` của từng node
- **TLS fingerprint (SHA-256)** — cert tự ký, node và trình duyệt phải được bảo tin
- **Mật khẩu admin** — chỉ hiện một lần, nếu `ADMIN_PASSWORD` để trống

Mở https://127.0.0.1:9443/admin/ (chấp nhận cảnh báo cert tự ký).

---

## ⚠️ HTTPS và fleet hiện tại

Server chạy **HTTPS duy nhất**. Spec §10 nói rõ:

> *"TLS is not yet available in the node (no TLS backend is compiled into the core on any platform)"*

Nghĩa là **node hiện tại không nói được HTTPS**. Cho tới khi core được biên dịch lại có TLS backend, fleet đang chạy sẽ không check update được. Có sẵn lối lùi:

```bash
ALLOW_PLAINTEXT_HTTP=1    # + expose HTTP_PORT (9099)
```

Nó mở thêm listener HTTP **chỉ phục vụ `/api/v1/*`**; `/admin/*` vẫn trả `426 Upgrade Required` để token không bao giờ đi trần. Mặc định **tắt** — đây là công tắc sự cố, không phải cấu hình khuyến nghị.

Với cert tự ký, node còn phải được nạp CA đó mới tin. Production nên mount cert thật đè lên `/data/tls/server.{crt,key}`.

---

## Kiến trúc

[`docs/c4.md`](docs/c4.md) — sơ đồ C4 (tiếng Anh) tách theo từng quá trình: system được quyết ở đâu và đi theo version thế nào, upload hai bước, node hỏi update, tải gói, báo kết quả, promote, xác thực, khởi động. Mọi tên module, route và bảng trong đó đọc ra từ code đang chạy.

## Cấu trúc

```
src/
├── server.js              entry: DB → migrate → bootstrap admin → khoá ký → TLS → listen
├── app.js                 middleware pipeline
├── config/                gom toàn bộ env một chỗ
├── domain/                quy tắc giao thức thuần (không I/O)
│   ├── version.js         so sánh version theo SỐ, không theo chuỗi (§1)
│   ├── platform.js        13 platform + canonical target sorted (§7)
│   ├── manifest.js        payload ký 6 trường, không newline cuối (§7)
│   └── bundle.js          luật kiểm nội dung gói upload
├── core/                  hạ tầng: router, http, errors, logger, range, files, tls, jwt,
│                          password, tar (đọc .tar.gz streaming, không dependency)
├── db/                    pool + migration runner + 001_init.sql
├── middlewares/           logger, apiKey, auth, staticFiles, notFound, errorHandler
├── routes/                URL → controller
├── controllers/           đọc request → gọi service → trả response
├── services/              nghiệp vụ: update, plan, manifest, download, signing, auth, publish
├── repositories/          nơi duy nhất chạm SQL (+ signingKey là file, không vào DB)
└── validators/            kiểm tra & chuẩn hoá input
public/admin/              web UI vanilla, không framework, không build step
tests/                     8 file unit (không cần DB) + 8 file tích hợp (cần Postgres)
```

Luồng một request:
```
errorHandler → requestLogger → parseUrl → securityHeaders → requireTls
             → maintenanceGate → router → staticFiles → notFound
```

---

## API cho node (`/api/v1`)

Xác thực bằng `X-API-Key` trên mọi endpoint trừ `/health`. Lỗi luôn là `{"error": "<mã>", "message": "<text>"}`.

| Method | Path | |
|---|---|---|
| `GET` | `/api/v1/health` | không cần auth (§12) |
| `GET` | `/api/v1/update/check` | một node — `serial`, `platform`, `version` bắt buộc; `system` tuỳ chọn (§2) |
| `GET` | `/api/v1/update/channels` | channel node được phép chọn, để máy hiện danh sách thay vì ô text (§2b) |
| `POST` | `/api/v1/update/check` | cả pairing GCS+AIR, trả kèm `plan` (§3) |
| `GET` | `/api/v1/update/download/{version}` | bytes `.tar.gz`, hỗ trợ `Range: bytes=N-` (§6) |
| `POST` | `/api/v1/update/report` | kết quả update (§11) |

```bash
K=your-api-key
curl -k https://localhost:9443/api/v1/health
curl -k -H "X-API-Key: $K" \
  "https://localhost:9443/api/v1/update/check?serial=SN-42&platform=linux-x86_64&version=0.13.3&system=HERA"
curl -k -H "X-API-Key: $K" \
  "https://localhost:9443/api/v1/update/channels?version=0.13.3&system=HERA"
curl -k -H "X-API-Key: $K" -H 'Range: bytes=4194304-' -D- -o part.tar.gz \
  "https://localhost:9443/api/v1/update/download/0.15.0?platform=linux-x86_64"
```

---

## Systems — nhiều loại thiết bị

AeroCore chạy trên nhiều loại: drone, GCS, và có thể thêm nữa. Chúng khác nhau về **plugin set và config**, kể cả khi cùng platform (cả hai đều có thể là `android-aarch64`).

### Node tự khai — và server vẫn không tin ngay

Update client gửi `system` trên mọi lần check ([`UpdateClient.cpp:196`](../aero-core-engine/library/update/UpdateClient.cpp)):

```cpp
// Which product this node is, so one server can serve several. Omitted
// entirely when the build was not stamped.
if (!ep.system.empty()) path += "&system=" + q(ep.system);
```

Giá trị đến từ `detect_system()` — đọc `manifest.json` của runtime đang chạy. Build không đóng dấu thì tham số vắng hẳn, nên fleet cũ vẫn chạy.

Đây là bằng chứng, **không phải mệnh lệnh**. Thứ tự server xếp một node:

| # | Nguồn | Khi nào |
|---|---|---|
| 1 | admin gán tay cho `serial` | luôn thắng — người đã quyết |
| 2 | `system` node gửi | có tên đó **và** không mâu thuẫn với (3) |
| 3 | system của release mang `version` node đang chạy | node không gửi `system` |
| 4 | system duy nhất tồn tại | server một system |
| — | không cái nào | **204** + vào hàng chờ |

Hai trường hợp cố ý **không đoán**, ghi lại rồi chờ admin:

- **Tên lạ.** Node khai `HERA-2`, server không có → 204, ghi cả tên đã khai vào cột *Says it is*. Không `400` (cả fleet sẽ spam lỗi vì một typo trong build script), không tự tạo system.
- **Mâu thuẫn.** Node khai `HERA` nhưng version nó chạy thuộc release của `drone`. Một trong hai sai và không cách nào biết bên nào — node vừa bị chuyển system thì nó đúng, build đóng dấu nhầm thì nó sai, nhìn từ đây y hệt nhau.

Vì sao khắt khe: đưa nhầm core của system khác là **thay cả plugin set lẫn config trong một bước**, và node ghi nhận đó là `system_mismatch` — một *skip non-fatal*. Update báo thành công, thực tế không có gì đổi.

### Bundle khai system của nó

Build đóng dấu vào manifest của core slice; `release.json` chỉ là đường lui cho build cũ:

```json
{ "package": "AeroCoreEngine", "version": "0.13.4",
  "platform": "linux-x86_64", "system": "HERA" }
```

Manifest **plugin** thì khác nghĩa hẳn: `"system"` ở đó là **danh sách sản phẩm plugin chạy được**.

```json
{ "plugin": "SRTunnel_Plugin", "version": "1.2.0",
  "system": ["HERA", "drone"] }
```

Nhiều plugin dùng chung được cho vài system — đó là chuyện bình thường, không phải lỗi. Cùng một plugin đó được đóng vào gói của từng system, mỗi gói vẫn thuộc đúng một system, và không có cảnh báo nào.

| `system` của plugin | Nghĩa |
|---|---|
| vắng / rỗng | chạy mọi nơi (`system_covers` trả `true`) |
| `"HERA"` | chỉ HERA |
| `["HERA","drone"]` | cả hai |
| không chứa system của gói | **cảnh báo** — node sẽ skip nó im lặng |

Cột **Runs on** trong panel upload chỉ nói khi có gì để nói: `any`, `—` (chỉ system này), `+ drone, rover` (dùng chung), hoặc tag đỏ khi không phủ.

⚠️ `system_covers` so bằng `==` trên `std::string` nên **phân biệt hoa thường**: `"Hera"` và `"HERA"` là hai system khác nhau với node. Server nói thẳng khi hai bên chỉ khác mỗi chữ hoa, vì trên màn hình chúng nhìn y hệt.

Chỉ core slice đặt tên system cho gói — một mảng không xác định được dòng version.

Admin **phải tạo system trước**. Tên lạ bị từ chối chứ không tự tạo — một lỗi chính tả sẽ âm thầm mở một dòng release riêng mà không node nào tham gia, và chỉ lộ ra dưới dạng "chẳng ai update cả".

### Node không xếp được

Thiết bị mới xuất xưởng báo version server chưa từng publish → **không trả update**, ghi vào danh sách chờ ở tab Systems để admin gán tay. Đoán bừa nghĩa là đẩy firmware drone sang GCS.

**Trừ khi chỉ có đúng một system.** Lúc đó không có gì để nhầm lẫn nên không có đáp án sai, node được phục vụ bình thường và danh sách chờ rỗng. Đây là trạng thái của mọi cài đặt hiện có (migration gom hết vào system `default`) — nếu không có luật này thì dựng một fleet 500 con sẽ là 500 lần bấm duyệt cùng một quyết định. Hàng chờ bắt đầu tồn tại đúng lúc bạn tạo system thứ hai.

### Channel thuộc về system

Một channel trỏ tới một version, mà version thuộc một system — nên `stable` toàn cục không phục vụ được hai system. Channel giờ khoá theo `(system, name)`, và mỗi system có `stable`/`beta` riêng:

```
POST /admin/api/systems           tạo system
PUT  /admin/api/systems/drone/channels/stable   {"latest":"1.1.0"}
GET  /admin/api/unclassified      node chưa xếp được
PUT  /admin/api/unclassified/SN-1 {"system":"drone"}
```

Trỏ channel của drone vào release của GCS bị từ chối:
> Release 2.1.0 belongs to system "gcs", not "drone".

**`update.channel` là param `list`, không phải chuỗi tự do**, và `options` của nó **đồng bộ từ server**. Description trong `core.json` ghi rõ: *"a server that sends a `channels` list replaces these options on the next check"*.

Phía node đã cài xong từ trước — `UpdateClient::check` đọc `channels` trong response, `UpdateService::sync_channel_options` ghi vào `options`, đặt `type:"list"`, và **bỏ qua nếu param đã khoá**. Server trước đây không gửi gì, nên dropdown trên máy mãi là menu đóng cứng lúc build.

Giờ mọi response check đều mang danh sách, **cả shape không có update**:

```json
{ "update_available": false, "channels": ["stable", "beta"] }
```

Phải có ở shape đó, vì máy đang trỏ vào channel không tồn tại nhận đúng shape đó mãi mãi — danh sách là thứ duy nhất sửa được nó. Chỉ system của chính node, gồm cả channel đang pause, và **không đụng chữ ký** (payload ký là sáu trường cố định).

Server **không bao giờ đặt `value`** — chỉ thay `options`. Chọn channel nào là việc của operator.

Máy đã gõ sai từ trước thì tab Channels hiện thẳng:
> 3 node(s) are asking for channel "beta" on system HERA, which has no such channel. They are being told they are up to date.

### Upload hai bước: xem trước rồi mới lưu

```
chọn file  →  server mở gói, hiện version / plugin / config / diff      CHƯA lưu gì
           →  [Upload to beta]  →  vào catalog, vào channel beta
           →  test trên beta
           →  [Promote]         →  stable
```

Bước một (`POST /admin/api/uploads`) chỉ đọc: nó stream bytes vào file tạm, mở gói, kiểm mọi luật, và trả về báo cáo kèm một **token**. Không một dòng nào vào database. Bước hai (`POST /admin/api/uploads/:token`) mới ghi.

Token chính là tên file tạm. Ba tính chất đi kèm:

- **Dùng một lần** — commit xong file đã rename đi, gọi lại là 404.
- **Hết hạn sau 1 giờ** — pruner sẵn có quét `.part`; commit muộn báo *"upload the file again"*, không phải 500.
- **Không phải UUID thì không chạm tới filesystem** — tham số này bị ghép vào đường dẫn, thiếu kiểm tra là traversal thẳng vào thư mục artifact.

Bước hai **kiểm lại từ bytes**, không tin kết quả bước một: giữa lúc xem và lúc bấm, người khác có thể đã upload cùng version, hoặc một release mới đặt thêm config param. Token chỉ nói *bytes nào*, không nói *bytes đó còn hợp lệ*.

`POST /admin/api/artifacts` một lệnh vẫn còn, cho CI.

### Hai channel cố định

Mỗi system có đúng `beta` và `stable`, tạo cùng lúc với system. Không có cái thứ ba và không đặt tên được — chính vì thế nút Promote chỉ có một đích và không cần dropdown.

⚠️ **Không còn pause / pin serial / block serial.** Phanh duy nhất khi gặp bản lỗi là trỏ `stable` về bản cũ, mà đường đó bị luật chống lùi chặn — nên `allow_rollback: true` giờ là lối thoát khẩn cấp chứ không phải tiện ích:

```bash
curl -X PUT .../api/systems/HERA/channels/stable \
  -d '{"latest":"0.13.4","allow_rollback":true}'
```

### Điều dễ sai nhất

`findPreviousRelease` và `configParamsBetween` **bắt buộc** phải giới hạn trong một system. Dòng version của hai system đan xen nhau về số, nên truy vấn không giới hạn sẽ lấy release GCS làm mốc cho release drone và mô tả một thiết bị không tồn tại. Có test riêng cho việc này.

---

## Phát hành một bản

Server **mở gói ra kiểm** trước khi nhận. `version` và danh sách `platforms` lấy từ chính `manifest.json` bên trong bundle — bạn không cần khai, và nếu có khai mà lệch thì upload bị từ chối.

**Qua web UI:** tab Publish → kéo-thả `.tar.gz` → server mở gói, hiện version/plugin/config và **so với bản trước** → bấm **Publish** để phát hành.

Không có bước nào phải gõ tay. Bản vừa upload nằm trong catalog nhưng **không node nào thấy** cho tới khi bấm Publish.

**Qua API (cho CI) — một lệnh:**

```bash
T=$(curl -sk -X POST https://localhost:9443/admin/api/auth/login \
     -H 'content-type: application/json' -H 'X-Requested-With: fetch' \
     -d '{"username":"admin","password":"..."}' | jq -r .access_token)

curl -sk -X POST https://localhost:9443/admin/api/artifacts \
  -H "Authorization: Bearer $T" -H 'content-type: application/gzip' \
  -H "X-Expected-Sha256: $(sha256sum bundle.tar.gz | cut -d' ' -f1)" \
  --data-binary @bundle.tar.gz | jq
```

Một lệnh đó làm hết:

| Việc | Nguồn |
|---|---|
| Tạo release | `version` trong `manifest.json` |
| `platforms`, `kind` | `components[].variants[].platform` |
| Version từng plugin | `plugins/<Name>/<platform>/manifest.json` |
| Param config sẽ đổi | payload `config/*.json`, làm phẳng thành `web.port` |
| System (drone / GCS / HERA…) | `system` trong `manifest.json` của core slice |
| `min_version`, `notes`, `mandatory` | `release.json` ở gốc gói (tuỳ chọn) |
| So sánh với bản trước | tự tính, hiện trước khi bấm Publish |

### System lấy từ manifest, không phải file phụ

Build đóng dấu `"system"` vào manifest của core slice và của từng plugin, nên gói tự khai nó
thuộc loại thiết bị nào — không cần thêm gì vào pipeline:

```json
{ "package": "AeroCoreEngine", "version": "0.13.4",
  "platform": "linux-x86_64", "system": "HERA", "build_type": "Debug" }
```

Server **không tự tạo** system từ tên đó; admin tạo trước ở tab Systems, gói khai tên lạ thì bị
từ chối. Chủ ý: một lỗi chính tả trong build script sẽ lặng lẽ dựng ra một dòng release song
song mà không node nào thấy.

Các slice trong cùng một gói phải khai cùng một system — khác nhau là lỗi `conflicting_systems`.
`release.json` vẫn khai `system` được cho gói build bằng script cũ; slice thắng khi cả hai có.

### `release.json` — metadata không suy được từ gói

Bundle manifest không có chỗ cho ba trường này, nên đặt thêm một file ở gốc gói. Không có cũng được, chỉ là để trống.

```json
{
  "min_version": "0.13.0",
  "mandatory": false,
  "notes": "Adds ZMQ bus self-description. Fixes config reset on OTA."
}
```

Metadata chỉ được áp **lúc tạo release**. Artifact thứ hai cho cùng version sẽ không ghi đè thứ operator đã sửa tay.

### ⚠️ Config bị bỏ sót khi node nhảy nhiều bản

Gói chỉ chở config của **chính release đó**. Node đi `0.13.0 → 0.15.0` **không bao giờ** nhận param mà `0.14.0` đặt: release đặt nó bị nhảy qua, còn payload của `0.15.0` không nhắc tới nó.

Phía node không có gì báo. `merge_slim_values` ghi đúng những khoá được đưa, rồi component config báo `applied` — vì nó *đã* áp hết thứ nhận được. Server là nơi duy nhất biết đủ để phát hiện.

```
0.13.0  ────────────────────────────────►  0.15.0
          0.14.0 đặt web.port=9090            gói 0.15.0 chỉ có general.fps
             (bị nhảy qua)                    → web.port KHÔNG BAO GIỜ được đặt
```

**Lúc upload** — cảnh báo `config_not_cumulative`, liệt kê đúng param cần thêm:

> Earlier releases set 1 param(s) this bundle does not: core.web.port (from 0.14.0). A node
> updating straight from before those releases will never receive them, and will report
> success anyway. Make the config payload cumulative.

**Lúc check** — mỗi node trong `plan` nhận thêm trường riêng, tính theo đúng khoảng nhảy của nó:

```json
"SN-42": {
  "platform": "linux-x86_64",
  "core":    { "from": "0.13.0", "to": "0.15.0" },
  "config":  [{ "target": "core", "param": "general.fps", "to": 60 }],
  "config_missing": [
    { "target": "core", "param": "web.port", "to": 9090, "set_by": "0.14.0" }
  ]
}
```

`config` là thứ sẽ đổi; `config_missing` là thứ **âm thầm không đổi**. Node ở ngay bản kề dưới thì không mất gì; node tụt vài bản có thể mất nhiều.

**Cách sửa — và server cưỡng chế nó.** `REQUIRE_CUMULATIVE_CONFIG=1` (mặc định) làm upload **bị từ chối 400** nếu payload bỏ sót param mà release cũ từng đặt.

Chính sách: **mỗi build chở toàn bộ config, param quan trọng khoá từ đầu.**

Gửi lại param mỗi lần là an toàn — đã xác minh trong `PackageApply.cpp:209-234`:

```cpp
if (is_frozen_param(fat[k]["params"][pk])) {   // locked hoặc readonly
    lockedSkipped->push_back(k + "." + pk);
    continue;                                   // GIỮ nguyên giá trị operator đã chỉnh
}
fat[k]["params"][pk]["value"] = pv;
```

Node chỉ ghi param **đang tồn tại** và **không bị khoá**; param đã khoá được bỏ qua và báo về trong `locked_skipped`. Nên chở full config không đè lên thứ đã tinh chỉnh.

> ⚠️ **Phải khoá TRƯỚC lần update đầu tiên chạm tới param đó.** Khoá sau khi một release đã ghi đè thì đã muộn — `locked` chỉ bảo vệ từ thời điểm nó được đặt.

Muốn bỏ hẳn một param khỏi dòng release thì khai trong `release.json`, nếu không nó bị coi là bỏ sót:

```json
{ "notes": "...", "config_dropped": ["core.web.port"] }
```

Đặt `REQUIRE_CUMULATIVE_CONFIG=0` để hạ xuống mức cảnh báo.

**Bắt buộc mọi bản phải chở config:** `REQUIRE_CONFIG_COMPONENT=1` từ chối bundle không có config component nào. Cần vì luật luỹ kế chỉ nổ khi đã có release trước đó set param — một dòng release chưa bao giờ chở config thì không bao giờ bị bắt.

⚠️ Chở `config/` trong core slice **không tính** là đã push config: nó thay mọi param chưa khoá thay vì đúng những param bạn nêu tên, và bị chặn riêng ở mục dưới.

### Upload không phải là phát hành

Mặc định upload chỉ đưa vào catalog. Response 201 kèm `diff` — đúng thứ sẽ đổi nếu phát hành:

```json
"diff": {
  "previousVersion": "0.14.2",
  "no_op": false,
  "platforms": { "added": ["android-aarch64"], "removed": [] },
  "cores":   [{ "platform": "linux-x86_64", "from": "0.14.2", "to": "0.15.0", "change": "updated" }],
  "plugins": [{ "name": "SRTunnel_Plugin", "platform": "linux-x86_64",
                "from": "1.2.0", "to": "1.3.0", "change": "upgraded" }],
  "config":  [{ "target": "core", "param": "web.port", "from": 8080, "to": 9090, "change": "changed" }]
}
```

`no_op: true` nghĩa là **phát hành cũng không đổi gì** — mọi node sẽ tải về rồi báo `skipped/same_version`. Không chỗ nào khác trong hệ thống nói được điều đó.

So sánh version plugin bằng **số**: `1.9.0 → 1.10.0` là *upgraded*, không phải downgrade. Bên nào báo `"unknown"` thì chỉ ghi *changed*, không xếp thứ tự (`isNewer` sẽ ném).

Phát hành:
```bash
curl -X PUT .../admin/api/systems/default/channels/stable -d '{"latest":"0.15.0"}'   # hoặc bấm Publish trên UI
```

**Mặc định bản mới vào `beta`.** Upload xong là nó nằm trên channel test ngay, `stable` giữ nguyên thứ đang phát cho tới khi admin promote — đúng quy trình ở trên, không phải nhớ bấm. Channel `beta` được tạo nếu chưa có: channel chỉ là con trỏ, khác với system vốn là một dòng version nên phải tạo có chủ ý.

Đặt `AUTO_PROMOTE_CHANNEL=` (rỗng) để quay lại kiểu staged — không vào channel nào cho tới khi bấm. CI muốn một lệnh thẳng ra stable: `?channel=stable` trên upload.

Xem lại diff sau: `GET /admin/api/artifacts/:id/diff`.

Dừng gấp: trỏ `stable` về bản cũ kèm `"allow_rollback": true`. Node đã cài bản mới không lùi (offer phải mới hơn hẳn) — cái này chặn lây lan cho máy chưa cập nhật và máy mới ra xưởng, không thu hồi được máy đã dính.

### `manifest.json` của mỗi plugin

Server đọc file này ở hai chỗ: `plugins/<Name>/<platform>/manifest.json` (plugin component) và `<core>/plugins/<Name>/manifest.json` (plugin đi kèm core).

Đây là định dạng `package_plugins_linux.sh` đã sinh ra:

```json
{
  "plugin": "Example_Plugin",
  "version": "0.1.0",
  "platform": "linux-x86_64",
  "build_type": "Release",
  "packaged_at_utc": "2026-07-28T06:21:15Z",
  "so_count": 1,
  "files": ["bin/libExample_Plugin.so"]
}
```

Server chỉ dùng **ba trường**:

| Trường | Dùng làm gì | Thiếu thì sao |
|---|---|---|
| `version` | điền `artifact_plugin`, dựng `plan` cho node | hiện `not recorded`, không đoán |
| `plugin` | đối chiếu với tên thư mục | bỏ qua |
| `platform` | đối chiếu với platform của variant/core | bỏ qua |

Còn lại (`build_type`, `packaged_at_utc`, `so_count`/`dll_count`, `files`, `abi`, `api_level`) server không đọc — thừa cũng không sao.

**Ba cảnh báo nó bắt được:**

- `plugin_version_unknown` — `version` là chuỗi `"unknown"` (build không có version define) hoặc không phải dotted-numeric → không xếp thứ tự được với version node đang chạy
- `plugin_slice_name_mismatch` — `plugin` khác tên thư mục. Thư mục mới là thứ node nạp, nên đây thường là manifest copy nhầm
- `plugin_slice_platform_mismatch` — `platform` khác platform của variant. Bản Windows ghi `"windows"` không kèm arch nên khớp tiền tố vẫn tính là đúng

Lưu ý một ca có thật trên đĩa: `dist/plugins_Debug/Example_Plugin/manifest.json` là **file 0 byte**. Server coi đó là không đọc được và cảnh báo, chứ không sập.

### Plugin nằm trong core

Runtime slice mang theo plugin của nó. Server liệt kê thành **bảng riêng**, không nhồi vào một ô — một slice thật thường có nhiều hơn 10 plugin:

```
PLUGINS INSIDE THE CORE (14)
  Plugin              Platform        Version
  Plugin_00           linux-x86_64    1.0.0
  ...
  Plugin_12           linux-x86_64    [not recorded]
```

Version đọc từ `manifest.json` trong từng thư mục plugin. Bản build cũ chỉ chép `.so` mà không chép manifest → hiện `not recorded`, **không đoán** — version sai trong `plan` tệ hơn version thiếu.

Nhóm plugin này khác plugin component: chúng bị thay nguyên khối cùng core, không có version độc lập, nên plugin operator tự cài trên node sẽ bị hoàn nguyên.

### Hai cơ chế config — đừng nhầm

| | **Config component** (hẹp, có chủ đích) | **config/ trong core slice** (thay nguyên khối) |
|---|---|---|
| Tạo bằng | `--config core=values.json` | build không có `-NoConfig` |
| Node áp bằng | `merge_slim_values` | `reconcile_config` |
| Ghi những param nào | **chỉ param payload nêu tên** | **mọi param node chưa khoá** |
| Param đã khoá | bỏ qua | bỏ qua |
| Param không nêu | không đụng | **lấy giá trị trong gói** |

Cả hai đều bỏ qua param đã khoá, nên nếu param sinh tử được lock từ đầu thì đường nào cũng an toàn. Khác nhau ở phạm vi: component chỉ đụng param nó nêu tên, còn config/ trong slice đụng mọi param chưa khoá.

`--core` và `--config` là **hai cờ riêng**, nên `-NoConfig` và push config hoàn toàn không mâu thuẫn — muốn giới hạn phạm vi thì dùng cách này:

```bash
# core không mang config/ ...
bash scripts/linux/build_dist_linux.sh -BuildType Release -NoConfig

# ... nhưng bundle vẫn chở config, dưới dạng component
bash scripts/package_update_bundle.sh --out ota.tar.gz --version 0.15.0 \
  --core   linux-x86_64=dist/runtime_Release \
  --config core=core-values.json \
  --config Camera_Argus_Plugin=camera-values.json
```

`core-values.json` là payload **slim**, chỉ giá trị:
```json
{ "web": { "port": 9090 }, "update": { "channel": "stable" } }
```

### ⚠️ Gói build kèm config sẽ ghi đè cấu hình node

Runtime slice mang theo `config/core.json` **đầy đủ**. Áp core là thay nguyên thư mục runtime, rồi `reconcile_config` merge — với **gói làm base** (`PackageApply.cpp:298-310`):

```cpp
if (is_frozen_param(live)) { out["value"] = live["value"]; return; }  // chỉ param ĐÃ KHOÁ giữ giá trị node
// còn lại: giữ nguyên giá trị của GÓI
```

Nghĩa là **mọi param node chưa khoá đều lấy giá trị trong gói**. Bản build mặc định mang `update.server_url=""`, `update.api_key=""`, `update.enabled=false` — áp lên node chưa khoá là node **mất đường về server vĩnh viễn**, không có cách nào cứu từ xa.

**AeroCore tự chặn việc này** — nhưng chỉ với param node **đã khoá**: `reconcile_param` giữ giá trị của node cho param `locked`/`readonly`, còn lại lấy giá trị của gói. Với chính sách khoá-từ-đầu, node được bảo vệ, nên server chỉ **cảnh báo**:

> The config shipped for linux-x86_64 would set `update.enabled=false`, `update.server_url=""`. A node keeps its own value only for params it has **LOCKED**; anything unlocked takes the value above, and a node that ends up with a blank server URL cannot be reached again.

Fleet nào provisioning **không** khoá chắc các param đó thì bảo vệ không có tác dụng — đặt `REFUSE_CONFIG_LIFELINE=1` để đổi cảnh báo thành từ chối 400.

Tất cả gộp vào **một** finding cho mỗi platform, kể cả `link.serial=""` (node mất serial, không target theo tên được nữa) và `link.role` (AIR bị lật thành GCS, ngừng trả lời GCS của nó). Một luật bắn mỗi param sẽ ra đúng bốn dòng đó ở mọi lần upload, và màn hình cảnh báo không bao giờ đổi là màn hình không ai đọc.

Ba mức, theo `locked` trong gói:

| finding | khi nào | vì sao khác nhau |
|---|---|---|
| `core_config_lifeline_unlocked` | param nguy hiểm, **không** locked | node mới toanh sẽ giữ nguyên trạng thái mở khoá đó vĩnh viễn |
| `core_config_lifeline_locked` | param nguy hiểm, **có** locked | node fresh an toàn; node đã provisioning thiếu khoá thì vẫn dính |
| `core_ships_config` | có config nhưng không có param nguy hiểm | chỉ nêu cơ chế, một dòng |

`reconcile_param` lấy trạng thái khoá từ **config sống trên node**, không phải từ gói (`out["locked"] = live.value("locked", false)`). Nên `locked` trong gói chỉ có tác dụng với node cài mới và param mới thêm — đủ để phân mức, không đủ để đảm bảo.

**Cách đúng:** lock các param sinh tử ngay trong build. Không phải "đừng push config" — chính sách ở đây là mọi build đều push config.

Panel upload và nút **Details** trong Catalog đều hiện đủ **hai loại config**, vì chúng hành xử khác hẳn nhau:

- **Config params set by this release** — từ config component; node chỉ ghi đúng những param này
- **Config shipped inside the core and plugins** — từ `config/` trong core slice **và trong từng plugin**; thay mọi param node chưa khoá

Plugin cũng chở config riêng, và `apply_plugin` áp nó qua **cùng** `reconcile_config_file` (`PackageApply.cpp:547`) — nên rủi ro y hệt core. Bảng gộp cả hai nguồn, cột **Ships with** cho biết param đến từ core hay từ plugin nào.

Cả hai bảng trình bày theo **group thu gọn được**, cùng idiom với màn System Config của aero-core-engine: mỗi group một mục có badge đếm param, bấm vào để đóng/mở.

```
core · linux-x86_64
  ▾ UPDATE      (3)
      server_url    "https://ota"     locked
      channel       "stable"          overwrites
      enabled       true              overwrites
  ▾ WEB         (1)
      port          8080              overwrites

Camera_Argus_Plugin · in core · linux-x86_64
  ▾ GENERAL     (2)
      fps           30                overwrites
```

Nhãn `overwrites` / `locked` / `readonly` — `locked` là trường hợp duy nhất gói **không** ghi đè được.

### Server kiểm những gì

Bundle được giải nén **trong bộ nhớ** (`node:zlib` + tar reader tự viết ở [`src/core/tar.js`](src/core/tar.js)) — không ghi ra đĩa, không gọi `tar`, không thêm dependency. Chỉ các file `manifest.json` được giữ lại.

Luật quan trọng nhất, và là lý do tính năng này tồn tại:

> **`core/<platform>/manifest.json` phải có `version` bằng version của bundle.**

`PackageApply.cpp:447-459` so version của **slice bên trong gói** với runtime đang chạy — nó **không bao giờ** đọc version ở manifest gốc. Bump version bundle mà quên đóng dấu lại slice thì node trả `{"action":"skipped","reason":"same_version"}`, `restart_required:false`, **không có `error`**, và `ok` vẫn `true`. Cả fleet tải 12 MB về, không đổi gì, dashboard xanh.

Từ chối (400, kèm `details[]` liệt kê **mọi** lỗi cùng lúc): không phải gzip/tar · thiếu `manifest.json` · version `0.0.0` (fallback khi quên `--version`) · version không dotted-numeric · **version slice lệch** · platform không có thật (node khớp bằng so chuỗi tuyệt đối) · platform khai trùng · path variant không có trong archive · core slice thiếu `bin/` · config component đứng trước core (sẽ bị ghi đè lúc restart) · khai `?platforms=`/`:version` lệch với gói.

Cảnh báo (vẫn nhận, ghi vào `artifact.inspection` xem lại được): định dạng legacy · component type lạ · core slice mang theo `plugins/` · plugin báo version `"unknown"` · plugin thiếu manifest.

Không có luật "file lạ" — `.components` là rác build mà `package_update_bundle.sh` luôn để lại, không bao giờ bị coi là lỗi.

Bundle tự nó do [`scripts/package_update_bundle.sh`](../aero-core-engine/scripts/package_update_bundle.sh) bên `aero-core-engine` tạo ra. Server **không bao giờ** tự dựng hay ký lại gói — §13: *"nothing is composed or signed per request"*.

### Khi bản mới hỏng

Không còn pause, pin hay block — chỉ còn một đường:

```bash
# trỏ stable về bản trước. Luật chống lùi bắt nói rõ ý định.
curl -sk -X PUT .../admin/api/systems/HERA/channels/stable -H "Authorization: Bearer $T" \
  -H 'content-type: application/json' -d '{"latest":"0.14.2","allow_rollback":true}'
```

Nó **chặn lây lan chứ không thu hồi**: máy đã cài `0.15.0` ở nguyên đó, vì offer phải mới hơn hẳn thì node mới nhận. Thứ cứu được là máy chưa cập nhật và máy mới ra xưởng.

Ghi vào audit log kèm `allow_rollback`, nên còn truy được ai lùi và lùi lúc nào.

## Bảo mật

**Hai đường xác thực tách bạch tuyệt đối.** `X-API-Key` chỉ mở `/api/v1/*`; JWT chỉ mở `/admin/*`. Không cái nào chấp nhận cái kia — §10 nói khoá fleet nằm trong `core.json` của **mọi** thiết bị, ai cầm một thiết bị là có nó.

**Chữ ký mới là thứ bảo vệ gói, không phải API key.** Ed25519 trên payload 6 trường; kẻ tấn công chặn được đường truyền vẫn không giả được chữ ký. Khoá riêng là file `0600` trên volume, **cố ý không vào DB** — mọi bản backup DB sẽ mang theo nó. Muốn đúng posture §10 thì ký offline và upload artifact kèm chữ ký sẵn.

**Phiên admin.** Access token JWT HS256 sống 15 phút, giữ trong biến JS (không localStorage — XSS đọc được ngay). Refresh token là giá trị ngẫu nhiên 32 byte trong cookie `HttpOnly; Secure; SameSite=Strict`, lưu DB dạng hash, **xoay vòng mỗi lần dùng**. Dùng lại một token đã xoay bị coi là bị đánh cắp → thu hồi cả họ token và ghi audit.

**Chống dò mật khẩu.** 5 lần sai/username hoặc 20 lần sai/IP trong 15 phút → 429. Sai user và sai mật khẩu trả cùng một message, và scrypt **luôn** chạy kể cả khi username không tồn tại — nếu không, thời gian phản hồi tự tố cáo username nào có thật.

**Lấy API key sau khi đăng nhập.** Tab Security hiện khoá fleet để provisioning một máy mà không cần SSH vào server:

```bash
curl -sk https://localhost:9443/admin/api/api-keys -H "Authorization: Bearer $T"
# {"keys":[{"fleet":"test-fleet","key":"…"}],"shared":true,"note":"…"}
```

Hiện **nguyên giá trị** chứ không che: lý do duy nhất mở thẻ đó là để chép vào thiết bị, và một dấu sao phải bấm mới lộ chẳng chặn được ai. Thứ khiến việc đọc có trách nhiệm là **audit log** — mỗi lần gọi ghi một dòng `apikey.read` kèm tên người đọc.

⚠️ Đây là **khoá dùng chung**: mọi node gửi cùng một chuỗi. Thấy nó là giả được bất kỳ node nào, và đổi nó nghĩa là provisioning lại toàn bộ fleet. Nó nằm ở `UPDATE_API_KEYS`, không nằm trong DB — nên endpoint này chỉ đọc, không tạo và không thu hồi được. Muốn khoá riêng từng máy, thu hồi được từng cái, thì cần chuyển API key vào DB — đó là thay đổi khác.

---

## Test

```bash
npm run test:unit     # 36 test, không cần gì cả
npm run test:docker   # dựng Postgres tạm rồi chạy toàn bộ
npm test              # test tích hợp SKIP nếu thiếu TEST_DATABASE_URL
```

Test tích hợp chạy trên **HTTPS thật** với cert tự ký sinh riêng cho từng lần, và mỗi file test dùng một schema Postgres riêng nên chạy song song được.

Những bẫy được ghim bằng test:
- payload ký §7 đúng **121 byte**, và ca "hai separator cuối" khi thiếu field optional
- node ở `0.9.0` **phải** được mời `0.10.0` (so sánh chuỗi cho kết quả ngược)
- `Range: bytes=N-` → 206 với `Content-Range` đúng; quá cỡ → 416 kèm `bytes */<size>`
- traversal `..%2f..%2fpackage.json` → 404, `%E0%A4%A` → 400 chứ không phải 500
- upload sai sha256 → 400 và **không để lại file nào**
- dùng lại refresh token đã xoay → thu hồi cả họ

---

## Biến môi trường

Xem [`.env.example`](.env.example). Bắt buộc: `DATABASE_URL`, `JWT_SECRET`, `UPDATE_API_KEYS`.

Đáng chú ý: `ALLOW_PLAINTEXT_HTTP` (mặc định `0`, xem cảnh báo trên) · `SLIM_FALLBACK_TO_FLEET` (mặc định `1` — §4 bảo build một bundle cho mọi platform, không có fallback này thì ai làm đúng §4 sẽ nhận `update_available:false` vĩnh viễn) · `MAINTENANCE` (chặn mọi thứ trừ `/health` khi đang publish dở) · `CHECK_LOG_RETENTION_DAYS`.

---

## Điểm phân xử khi spec mơ hồ

- **`platform` trên `/download` là optional.** §6 ghi required, nhưng §3 nói url fleet không mang query và OpenAPI khai `required: false` + *"OMIT IT to get the fleet catalog artifact"*. Coi là required thì mọi câu trả lời fleet đều không tải được.
- **`Range` hỏng cú pháp → 200 full body** (RFC 9110 §14.2 bảo bỏ qua), khác reference impl vốn trả 416. Quá cỡ và multi-range vẫn 416 đúng spec.
- **Channel lạ → `update_available:false`, không phải 400.** §2 làm "withheld" và "current" không phân biệt được với node.
- **`min_version`**: §8 đặt việc cưỡng chế ở node, nên server vẫn offer và chỉ báo, kèm log warning nêu serial.
- **Không rate-limit `/api/v1`** (§9 cho node poll mỗi giờ có jitter; limiter sai `X-Forwarded-For` biến một fleet sau NAT thành tự-DoS). **Có rate-limit `/auth/login`** — bài toán hoàn toàn khác.
