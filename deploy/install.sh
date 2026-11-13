#!/bin/bash
# Cài / cập nhật Nha Khoa Trẻ trên VPS Ubuntu/Debian.
# Chạy trong thư mục dự án:   sudo bash deploy/install.sh [ten-mien.com]
# Chạy lại lệnh này bất cứ lúc nào để cập nhật code (dữ liệu tài khoản được giữ nguyên).
set -e
APP_DIR=/opt/nhakhoatre
APP_USER=nhakhoatre
PORT=3000
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-}"
SAVED_DOMAIN_FILE=/etc/nhakhoatre-domain
if [ -z "$DOMAIN" ] && [ -f "$SAVED_DOMAIN_FILE" ]; then DOMAIN="$(cat $SAVED_DOMAIN_FILE)"; fi

if [ "$(id -u)" != "0" ]; then echo "Hãy chạy bằng sudo hoặc tài khoản root."; exit 1; fi

echo ">>> 1/5 Cài các gói cần thiết"
apt-get update -qq
apt-get install -y -qq nginx curl rsync ca-certificates >/dev/null
NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "    Cài Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "    Node.js $(node -v)"

echo ">>> 2/5 Chép mã nguồn vào $APP_DIR"
id -u $APP_USER >/dev/null 2>&1 || useradd --system --home $APP_DIR --shell /usr/sbin/nologin $APP_USER
mkdir -p $APP_DIR/data
rsync -a --delete --exclude data --exclude .git --exclude node_modules "$SRC_DIR"/ $APP_DIR/
chown -R root:root $APP_DIR
chown -R $APP_USER:$APP_USER $APP_DIR/data
chmod 700 $APP_DIR/data

echo ">>> 3/5 Tạo dịch vụ chạy nền (tự khởi động lại khi VPS reboot)"
cat > /etc/systemd/system/nhakhoatre.service <<UNIT
[Unit]
Description=Nha Khoa Tre - Thu vien tu van noi bo
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT HOST=127.0.0.1 NODE_ENV=production
ExecStart=$(command -v node) $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable nhakhoatre >/dev/null 2>&1
systemctl restart nhakhoatre

echo ">>> 4/5 Cấu hình Nginx"
if [ -n "$DOMAIN" ]; then
  LISTEN="listen 80;"; NAME="$DOMAIN"; echo "$DOMAIN" > $SAVED_DOMAIN_FILE
else
  LISTEN="listen 80 default_server; listen [::]:80 default_server;"; NAME="_"
  rm -f /etc/nginx/sites-enabled/default
fi
# Giữ lại phần HTTPS nếu certbot đã cấu hình trước đó
if [ -f /etc/nginx/sites-available/nhakhoatre ] && grep -q "managed by Certbot" /etc/nginx/sites-available/nhakhoatre; then
  echo "    Đã có HTTPS (certbot) - giữ nguyên cấu hình Nginx."
else
cat > /etc/nginx/sites-available/nhakhoatre <<NGINX
server {
    $LISTEN
    server_name $NAME;
    client_max_body_size 1m;

    gzip on;
    gzip_proxied any;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$http_host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
fi
ln -sf /etc/nginx/sites-available/nhakhoatre /etc/nginx/sites-enabled/nhakhoatre
nginx -t
systemctl reload nginx

echo ">>> 5/5 Mật khẩu truy cập"
if [ ! -f $APP_DIR/data/db.json ] || ! grep -q '"admin": {' $APP_DIR/data/db.json; then
  cd $APP_DIR && runuser -u $APP_USER -- node server.js set-admin
else
  echo "    Đã có mật khẩu (đổi mật khẩu trên trang /admin, hoặc: cd $APP_DIR && sudo -u $APP_USER node server.js set-admin)"
fi

sleep 1
if systemctl is-active --quiet nhakhoatre; then
  IP=$(curl -s -4 --max-time 5 ifconfig.me || hostname -I | awk '{print $1}')
  echo ""
  echo "=================== XONG ==================="
  if [ -n "$DOMAIN" ]; then echo " Trang tư vấn  : http://$DOMAIN"; echo " Trang quản trị: http://$DOMAIN/admin"
  else echo " Trang tư vấn : http://$IP"; echo " Trang quản trị: http://$IP/admin"; fi
  echo "============================================"
else
  echo "Dịch vụ chưa chạy được. Xem lỗi: journalctl -u nhakhoatre -n 50"
  exit 1
fi
