# 《寻宝奇兵》后端反向代理（由 server/deploy/install.sh 安装到宿主机
# /data/nginx/conf.d/treasure-locations.inc，即容器内 /etc/nginx/conf.d/treasure-locations.inc）。
#
# 该文件被 include 进 nginx 的 443 server 块（由 install.sh 注入一行
#   include /etc/nginx/conf.d/treasure-locations.inc;
# 并带标记注释 # TREASURE-GAME-INCLUDE 做幂等判断）。
#
# 后端只监听 docker0 网关 172.17.0.1:3001，不直接暴露公网端口；
# proxy_pass 结尾的 "/" 会剥掉 /treasure/ 前缀后转发（/treasure/api/health -> /api/health）。

location = /treasure {
    return 301 /treasure/;
}

location /treasure/ {
    proxy_pass http://172.17.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";

    client_max_body_size 32m;
    proxy_connect_timeout 10s;
    proxy_send_timeout 300s;
    proxy_read_timeout 300s;
}
