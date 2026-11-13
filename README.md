# Nha Khoa Trẻ · Thư viện tư vấn nội bộ

Trang tư vấn nội bộ, bảo vệ bằng **một mật khẩu chung**.

- Mở trang sẽ thấy màn hình nhập mật khẩu. Nhập đúng thì xem được toàn bộ thư viện tư vấn.
- Trang `/admin` (dùng cùng mật khẩu):
  - **Đổi mật khẩu**: mọi thiết bị khác đang đăng nhập bị đăng xuất ngay.
  - **Nhật ký đăng nhập**: thời gian, IP, thiết bị, các lần nhập sai.
  - **Đăng xuất tất cả thiết bị khác** mà không cần đổi mật khẩu.
- Nhập sai mật khẩu 10 lần liên tiếp thì IP đó bị chặn 15 phút.

Không dùng thư viện ngoài, chỉ cần Node.js 18 trở lên.

## Cấu trúc thư mục

```
server.js          Máy chủ (đăng nhập, quản trị, phục vụ trang)
views/             Giao diện đăng nhập + trang quản trị
public/index.html  Trang thư viện tư vấn
public/assets/     Ảnh và video
deploy/install.sh  Script cài lên VPS (chạy lại = cập nhật)
deploy/update.sh   Lấy code mới từ GitHub rồi cài lại
data/              Mật khẩu (đã mã hoá) + nhật ký (tự tạo, KHÔNG đưa lên GitHub)
```

## Cài lên VPS (Ubuntu 20.04 trở lên / Debian 11 trở lên)

```bash
# Trên máy tính: tải file zip lên VPS
scp NhaKhoaTre_App.zip root@IP_VPS:/root/

# Trên VPS
ssh root@IP_VPS
apt install -y unzip
unzip NhaKhoaTre_App.zip -d nhakhoatre && cd nhakhoatre
sudo bash deploy/install.sh                 # chạy bằng địa chỉ IP
# hoặc: sudo bash deploy/install.sh tuvan.nhakhoatre.com   (nếu đã trỏ tên miền về VPS)
```

Cuối quá trình cài, script sẽ hỏi **mật khẩu truy cập** (ít nhất 8 ký tự). Xong thì mở `http://IP_VPS`.

### Bật HTTPS (khi đã có tên miền)

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d tuvan.nhakhoatre.com
```

## Đưa lên GitHub và cập nhật tự động

1. Tạo repo **Private** trên GitHub, ví dụ `nhakhoatre-tuvan-noibo`.
2. Trên máy tính, cài **GitHub Desktop** (desktop.github.com) rồi đăng nhập.
3. Chọn *File → Add local repository* và trỏ tới thư mục đã giải nén. Nếu được hỏi thì bấm *create a repository*.
4. Bấm **Commit to main**, sau đó **Publish repository**. Nhớ tích chọn **Keep this code private**.

> Không kéo thả qua trang web GitHub: trang web chỉ nhận tối đa 100 file mỗi lần, mà dự án có hơn 440 file.

### Cho VPS lấy code từ repo private (làm 1 lần)

```bash
# Trên VPS
ssh-keygen -t ed25519 -f ~/.ssh/github_nkt -N ""
cat ~/.ssh/github_nkt.pub
```

Chép dòng vừa hiện ra, vào repo trên GitHub, chọn **Settings → Deploy keys → Add deploy key**, dán vào rồi bấm lưu. Không tích ô *Allow write access*.

```bash
printf "Host github.com\n  IdentityFile ~/.ssh/github_nkt\n" >> ~/.ssh/config
git clone git@github.com:TEN_TAI_KHOAN/nhakhoatre-tuvan-noibo.git /root/nhakhoatre-src
cd /root/nhakhoatre-src && sudo bash deploy/install.sh
```

### Mỗi lần sửa nội dung

1. Sửa file trên máy tính, rồi trong GitHub Desktop bấm **Commit** và **Push**.
2. Trên VPS chạy:

```bash
cd /root/nhakhoatre-src && sudo bash deploy/update.sh
```

Mật khẩu và nhật ký nằm trong `/opt/nhakhoatre/data`, nên cập nhật code không làm mất dữ liệu.

## Lệnh hay dùng trên VPS

| Việc cần làm | Lệnh |
|---|---|
| Quên mật khẩu (đặt lại) | `cd /opt/nhakhoatre && sudo -u nhakhoatre node server.js set-admin` |
| Xem tình trạng | `systemctl status nhakhoatre` |
| Xem lỗi | `journalctl -u nhakhoatre -n 50` |
| Khởi động lại | `systemctl restart nhakhoatre` |
| Sao lưu mật khẩu + nhật ký | `tar czf ~/nkt-data-$(date +%F).tgz -C /opt/nhakhoatre data` |

## Chạy thử trên máy tính

```bash
node server.js set-admin
node server.js          # mở http://127.0.0.1:3000
```
