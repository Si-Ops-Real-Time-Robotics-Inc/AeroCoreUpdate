# AeroCoreUpdate

Server phát bản OTA cho fleet GCS/AIR. Tổng quan ở [README.md](README.md).

> **`docs/` hiện đang rỗng.** `c4.md`, `update-server-api.md` (spec normative),
> `update-server-openapi.json` và `rbac-proposal.md` đã bị xoá khỏi working tree và **cố ý
> không khôi phục** — sẽ dựng lại. Bản đã commit vẫn nằm trong git (`git show HEAD:docs/c4.md`)
> nếu cần tham khảo cấu trúc cũ. README vẫn còn link tới các file này; link đang hỏng.

## Vị trí trong hệ thống — rule nền, mọi thứ dưới đây suy ra từ đó

1. **Server này là một microservice của `proxy_alpha`**, không phải sản phẩm đứng một mình.
   Trước khi thêm bất cứ thứ gì, hỏi: phần này thuộc AeroCoreUpdate hay thuộc proxy_alpha?
   Cái gì proxy_alpha đã làm thì ở đây không làm lại.
2. **Luôn chạy dưới dạng Docker container.** Mọi thay đổi phải đúng khi chạy trong container:
   đường dẫn ghi được chỉ có `/data` (volume), cấu hình vào bằng env, không có kịch bản chạy
   trần trên host để mà dựa vào.
3. **Đăng nhập phụ thuộc proxy_alpha.** proxy_alpha vừa host Keycloak vừa là gateway đứng
   trước container này. Server này **không định nghĩa danh tính người dùng**, nó chỉ *verify*
   token do realm của proxy_alpha cấp, và mọi request từ ngoài đều đi qua gateway.

## Hệ quả bắt buộc

### Danh tính thuộc về proxy_alpha

- Không thêm user store cục bộ, không tự phát hành token danh tính, và **không giữ credential
  nào mở được chính server này**. Không có tài khoản local — Keycloak là nguồn duy nhất.
  Đường đăng nhập mật khẩu đã được gỡ hẳn (feature 002, migration 010).
- Hệ quả đã chấp nhận có chủ đích: realm không với tới được thì admin API cũng không, kể cả
  để dừng một đợt rollout. Câu trả lời cho việc đó là một Keycloak đáng tin, không phải một
  cửa phụ trong repo này.
- **Node cũng phải đăng nhập.** `FLEET_AUTH_MODE=jwt`, nên node lấy token từ realm (role
  `aerocore-fleet`) và trình bearer như mọi client khác; `X-API-Key` không còn được nhận.
  Fleet không phải ngoại lệ của danh tính.
- **Node thừa hưởng chính sách channel của account nó đăng nhập.** `aerocore-fleet` → mọi
  channel kể cả `beta`; `aerocore-fleet-stable` → chỉ thứ `stable` đang trỏ tới. Chặn ở **cả
  hai** route: số hiệu phiên bản không phải bí mật, nên `/update/download/{version}` cũng nhận
  danh sách channel. Từ chối chứ không âm thầm đổi sang channel khác.
- **Mọi thứ phải đi qua gateway của proxy_alpha** — cả node, không riêng trình duyệt. Hiện
  compose vẫn publish `9443:9443` trên network riêng nên node đang dial thẳng; xem mục
  "Network và TLS" bên dưới và ghi chú trong `docs/c4.md`.
- Tên realm role và audience (`OIDC_ADMIN_ROLE`, `OIDC_AUDIENCE_ADMIN`, `OIDC_FLEET_ROLE`, …)
  là **hợp đồng với realm của proxy_alpha**, dùng chung với AeroCore và aerotunnel. Đổi tên ở
  đây là đổi ở cả ba; không tự đặt role mới rồi mong realm có sẵn.
- Token phải ký **EdDSA**. Realm mặc định ra RSA, mà node Android không verify được RS256
  (NDK không có OpenSSL). Đây là ràng buộc của fleet, không phải sở thích.

### Đứng sau gateway thì URL do proxy_alpha quyết

- `PUBLIC_BASE_URL` là **bắt buộc**, không phải tuỳ chọn. `callbackUri()`
  ([src/controllers/auth.controller.js:69](src/controllers/auth.controller.js#L69)) fallback về
  `:authority`/`Host`; sau gateway đó là địa chỉ nội bộ, và Keycloak sẽ trả
  `invalid_redirect_uri`.
- Redirect URI đăng ký trên client Keycloak là **địa chỉ public của proxy_alpha**, không phải
  `https://<this server>:9443/*` như `.env.example` đang hướng dẫn.
- Split-horizon là trạng thái bình thường ở đây: `iss` trong token là URL public, còn container
  dial Keycloak qua mạng nội bộ → phải set `OIDC_ISSUER` và `OIDC_JWKS_URI`. Compose đã
  pass sẵn hai biến ([docker-compose.yml:108-109](docker-compose.yml#L108-L109)).
- `PUBLIC_BASE_URL` cũng quyết URL nằm trong **manifest đã ký**
  ([src/services/manifest.service.js:67](src/services/manifest.service.js#L67)) — node phải tải
  được qua proxy_alpha, nên đây là URL public chứ không phải tên container.

### IP nhìn thấy được là IP của gateway

`clientIp()` ([src/controllers/auth.controller.js:78](src/controllers/auth.controller.js#L78))
đọc `req.socket.remoteAddress`. Sau proxy_alpha mọi request đều mang IP của gateway:

- `REGISTER_MAX_PER_IP` gom cả thế giới vào một rổ — hoặc chặn nhầm người thật, hoặc vô dụng.
- IP ghi vào session và audit (dòng 102, 127) là IP gateway, không truy vết được ai.

Chưa xử lý. **Đừng viết code mới coi `clientIp()` là IP thật.** Làm cho đúng nghĩa là đọc header
chuyển tiếp của proxy_alpha và chỉ tin nó khi request đến từ gateway — tin vô điều kiện thì bất
kỳ ai cũng giả được IP để lách rate limit.

### Network và TLS

- `docker-compose.yml` hiện publish `9443:9443` trên network riêng `aerocoreupdate`, **chưa
  join network của proxy_alpha**. Deploy thật cần khai báo network external của proxy_alpha và
  cân nhắc bỏ publish port ra host — nếu gateway là đường vào duy nhất thì mở cổng ra host là
  mở một đường vòng qua nó.
- HTTPS-only giữ nguyên. `ALLOW_PLAINTEXT_HTTP` là công tắc sự cố cho fleet chưa có TLS
  backend, không phải cấu hình khuyến nghị, và `/admin/*` vẫn phải trả 426.
- `TLS_SAN` phải kể tên đúng địa chỉ mà bên kia thực sự dial. Nếu proxy_alpha terminate TLS thì
  đó là tên nội bộ mà gateway dùng, không phải tên public.

### Chưa chốt — hỏi trước khi tự điền

Tên network / hostname nội bộ / URL public của proxy_alpha, và realm name dùng chung. Trong repo
chưa có chỗ nào ghi, đừng đoán.

## Bắt đầu một chức năng nghĩa là gì

**Chức năng mới đi qua Spec Kit, không đi thẳng vào code.** Các skill nằm sẵn trong
[.claude/skills/](.claude/skills/), gọi bằng `/speckit-*`, và artifact rơi vào
`specs/<NNN-tên>/` (`spec.md`, `plan.md`, `tasks.md`, kèm `research.md` và
`data-model.md` khi cần).

Chuỗi bắt buộc:

```
/speckit-specify   mô tả bằng lời → spec.md
/speckit-plan      spec → plan.md (quyết định kỹ thuật, ràng buộc)
/speckit-tasks     plan → tasks.md, xếp theo thứ tự phụ thuộc
/speckit-implement thực thi tasks.md
```

Ba cái nữa, không bắt buộc nhưng rẻ hơn nhiều so với sửa sau:

- `/speckit-clarify` **trước** `/speckit-plan` khi yêu cầu còn mơ hồ — nó hỏi tối đa 5 câu
  rồi ghi câu trả lời ngược vào spec, thay vì để một giả định đi suốt xuống tận code.
- `/speckit-analyze` sau `/speckit-tasks` — đối chiếu spec, plan và tasks xem có chỗ nào nói
  ngược nhau.
- `/speckit-converge` khi code đã đi trước spec: nó soi codebase rồi bổ sung phần còn thiếu
  vào `tasks.md`.

### Vì sao, và cái gì được miễn

Lý do không phải là thủ tục: spec là chỗ **quyết định** mục `L3.x` trong `docs/c4.md` (file đang cần dựng lại — xem đầu trang) và
quyết định test nào phải có — tức là hai điều kiện ở mục dưới. Nghĩ ra chúng lúc viết spec
là thiết kế; nghĩ ra lúc đã code xong là chép lại những gì lỡ làm.

Không phải mọi thay đổi đều cần chuỗi này. **Được miễn**: sửa một dòng, đổi một giá trị
config, sửa lỗi chính tả, và xử lý sự cố đang chạy. **Không được miễn**: bất cứ thứ gì thêm
route, thêm bảng, đổi hợp đồng API, hoặc đụng tới cách xác thực.

Bỏ qua chuỗi này cho một chức năng thật là một quyết định phải **nói ra trước**, kèm lý do —
không phải mặc định im lặng.

### Điều kiện tiên quyết chưa xong

`.specify/memory/constitution.md` **vẫn đang là template rỗng**. Mọi lệnh trên đều có bước
đối chiếu với constitution, nên chạy lúc này là đối chiếu với `[PRINCIPLE_1_NAME]` — bước
kiểm tra pass mà không kiểm gì cả. Chạy `/speckit-constitution` một lần trước đã, và các
nguyên tắc thật của dự án nằm ngay trong file này: vị trí microservice trong proxy_alpha,
zero-dependency, `repositories/` là nơi duy nhất chạm SQL, và hai điều kiện hoàn thành dưới.

## Làm xong một chức năng nghĩa là gì

Ba việc dưới đây **bắt buộc**, không phải tuỳ tình huống. Code chạy được mà thiếu một trong
ba thì chức năng đó chưa xong.

### 1. Viết xong phải chạy lại test

Chạy `npm test` — không phải chỉ `npm run test:unit`, vì phần lớn đường đi thật nằm ở nhóm
test cần Postgres. Máy chưa có DB thì `npm run test:docker` (tự dựng Postgres tạm rồi dọn).

- Chạy **toàn bộ**, không chỉ test của phần vừa sửa. Các lớp ở đây dùng chung `config/` và
  middleware pipeline, nên sửa một chỗ làm đỏ một chỗ khác là chuyện thường.
- Đỏ thì **báo nguyên văn output**, không tóm tắt thành "có vài test fail", không tự ý bỏ qua.
- Thêm chức năng thì thêm test cho nó. Xanh vì không có test nào chạm tới phần mới thì không
  tính là xanh.
- `npm test` đã tự chạy `npm run check` trước — đừng bỏ qua bước đó, nó bắt hàm được gọi
  nhưng không ai định nghĩa, thứ mà `node --check` không thấy.

### 2. Chức năng nào cũng phải có C4 diagram

Người sau hiểu hệ thống qua `docs/c4.md`, không phải bằng cách đọc code. Chức năng không đọc
ra được từ file đó coi như chưa bàn giao.

**File này đang chưa tồn tại và cần được dựng lại.** Chức năng đầu tiên đụng tới nó có trách
nhiệm tạo lại khung: `# C4 — AeroServer`, rồi `## L1 — Context`, `## L2 — Container`, các mục
`## L3.x` cho từng quá trình, và `## Data` ở cuối. Không bê nguyên bản cũ trong git về — nó tả
kiến trúc trước khi có proxy_alpha, nên L1 và L2 đã sai.

- Một chức năng = một mục `## L3.x — <tên>` mô tả luồng đi của nó, kèm sơ đồ trong fence
  ` ```mermaid `. Đánh số tiếp nối, mỗi mục một quá trình.
- Sửa chức năng sẵn có thì **sửa mục L3.x tương ứng**, đừng thêm mục mới song song rồi để hai
  bản mô tả cùng một thứ.
- Đụng tới ranh giới container hay đường vào (thêm service, đổi cách gateway route) thì sửa
  thêm **L2 — Container**. Đụng tới proxy_alpha hoặc tác nhân ngoài thì sửa **L1 — Context**.
- Thêm hoặc đổi bảng thì cập nhật mục **Data** và ghi migration tương ứng.
- Luật của file đó: **mọi tên module, route, bảng trong đây phải đọc ra được từ code đang
  chạy**. Không vẽ thứ chưa tồn tại, không giữ lại thứ đã xoá.

### 3. Dọn lại trước khi gọi là xong

Code chạy được không phải là code bàn giao được. Trước khi coi một chức năng là xong, dọn
đúng những thứ chính chức năng đó để lại:

- **Biến `.env` không còn ai đọc thì xoá** — khỏi `.env.example`, khỏi `docker-compose*.yml`,
  khỏi `Dockerfile`. Một biến chết là một lời hứa sai: người sau đọc nó, chỉnh nó, rồi mất
  nửa buổi tìm hiểu vì sao chỉnh mà không có gì đổi.
- **Chiều ngược lại cũng phải khớp**: biến code có đọc thì `.env.example` phải nhắc, kèm lý do
  tồn tại. Một knob không ai biết thì cũng như không có.
- Xoá luôn export không còn ai import, component không còn ai render, và nhánh `if` chỉ còn
  phục vụ một đường đi đã bỏ.
- `npm run check` bắt hàm được gọi mà không ai định nghĩa. Nó **không** bắt chiều ngược lại —
  thứ được định nghĩa mà không ai gọi — nên phần đó đang phải làm bằng mắt.

**Ba trường hợp KHÔNG phải vi phạm**, đừng xoá nhầm:

1. Biến đặt ở tầng image (`PORT`, `HOST`, `ARTIFACTS_DIR`, `SIGNING_KEY_FILE`, `TLS_*_FILE`
   trong `Dockerfile`) — chúng thuộc về image, không thuộc `.env`.
2. Biến shell cục bộ trong `docker/entrypoint.sh` (`CERT`, `KEY`, `SAN`) — không phải cấu hình.
3. Công tắc sự cố chưa ai bật (`ALLOW_PLAINTEXT_HTTP`, `MAINTENANCE`). Không dùng đến là
   trạng thái mong muốn của chúng, không phải bằng chứng chúng thừa.
4. Bộ component `webui/src/components/ui/` và `lib/sort.ts` — mirror từ proxy-alpha cho các
   màn **chưa port**. Chúng chưa được dùng vì công việc chưa tới, không phải vì thừa. Nhưng
   đây là nợ có hạn: khi năm tab kia xong, thứ nào vẫn không ai gọi thì lúc đó là rác thật.

Rule này nhắm vào **thứ chính chức năng vừa làm để lại**, không phải mọi export chưa ai gọi
trong repo. Quét cả repo rồi xoá theo kết quả là cách nhanh nhất để gỡ mất một thư viện.

Xoá một biến cấu hình là thay đổi chạm tới triển khai đang chạy: nói ra là mình xoá cái gì và
vì sao, đừng lặng lẽ dọn.

## Lệnh

```bash
npm test           # check-refs + toàn bộ node --test (cần Postgres, xem test:docker)
npm run test:unit  # phần thuần, không cần DB
npm run test:docker # dựng Postgres tạm rồi chạy full test
npm run check      # bắt hàm được gọi nhưng không ai định nghĩa
npm run dev:docker # compose dev + follow log
```

## Quy ước code

- ESM, Node >= 20. Dependency runtime **duy nhất** là `pg` — thêm package mới cần lý do rất
  mạnh; tar, JWT, TLS, router đều đã tự viết trong `src/core/`.
- Phân lớp: `routes/` → `controllers/` → `services/` → `repositories/`. `repositories/` là nơi
  **duy nhất** chạm SQL. `domain/` là quy tắc giao thức thuần, không I/O.
- Test bằng `node --test`, không framework. `npm test` chạy `npm run check` trước.
- Comment trong repo này giải thích *tại sao*, không mô tả lại code. Viết thêm thì theo giọng đó.
