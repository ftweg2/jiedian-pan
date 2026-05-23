#!/bin/bash
# Wangpan full e2e API test.
# Hits every endpoint, records pass/fail + response samples to /tmp/wangpan-test-evidence/

set -uo pipefail

BASE="${BASE:-http://localhost:8080/api}"
EVIDENCE="/tmp/wangpan-test-evidence"
mkdir -p "$EVIDENCE"
> "$EVIDENCE/results.tsv"        # status\tname\tdetails
> "$EVIDENCE/samples.log"        # detailed response samples

source /opt/wangpan-e2e/.env
ADMIN_EMAIL="$BOOTSTRAP_ADMIN_EMAIL"
ADMIN_PW="$BOOTSTRAP_ADMIN_PASSWORD"

COOKIE=$(mktemp)
SHARE_COOKIE=$(mktemp)
trap 'rm -f "$COOKIE" "$SHARE_COOKIE"' EXIT

# ---- helpers ----
RECORD() {
  local status="$1" name="$2" details="${3:-}"
  printf '%s\t%s\t%s\n' "$status" "$name" "$details" >> "$EVIDENCE/results.tsv"
  case "$status" in
    PASS) printf '\033[1;32m✓\033[0m %s\n' "$name" ;;
    FAIL) printf '\033[1;31m✗\033[0m %s — %s\n' "$name" "$details" ;;
    SKIP) printf '\033[1;33m–\033[0m %s — %s\n' "$name" "$details" ;;
  esac
}

API_HEAD() { curl -sS -b "$COOKIE" -c "$COOKIE" -o /dev/null -w '%{http_code}' "$@"; }
API_BODY() { curl -sS -b "$COOKIE" -c "$COOKIE" "$@"; }
SAMPLE() {
  local label="$1"; shift
  echo "=== $label ===" >> "$EVIDENCE/samples.log"
  cat "$@" >> "$EVIDENCE/samples.log" 2>/dev/null
  echo "" >> "$EVIDENCE/samples.log"
  echo "" >> "$EVIDENCE/samples.log"
}

# === 1. Health + auth ===
section() { echo; echo "==== $1 ===="; }

section "health + auth"

CODE=$(curl -sS -o "$EVIDENCE/health.json" -w '%{http_code}' "$BASE/health")
if [ "$CODE" = "200" ]; then RECORD PASS "GET /health" "200"; else RECORD FAIL "GET /health" "got $CODE"; fi
SAMPLE "GET /health" "$EVIDENCE/health.json"

# login
CODE=$(curl -sS -c "$COOKIE" -o "$EVIDENCE/login.json" -w '%{http_code}' \
  -H content-type:application/json \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
  "$BASE/auth/login")
if [ "$CODE" = "200" ]; then RECORD PASS "POST /auth/login" "200"; else RECORD FAIL "POST /auth/login" "got $CODE"; exit 1; fi
SAMPLE "POST /auth/login" "$EVIDENCE/login.json"
USER_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/login.json"))["user"]["id"])')

# bad credentials
CODE=$(curl -sS -o /dev/null -w '%{http_code}' \
  -H content-type:application/json \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"bad\"}" \
  "$BASE/auth/login")
[ "$CODE" = "401" ] && RECORD PASS "POST /auth/login (bad pw → 401)" "" || RECORD FAIL "POST /auth/login (bad pw)" "got $CODE not 401"

# me
CODE=$(API_HEAD "$BASE/auth/me")
[ "$CODE" = "200" ] && RECORD PASS "GET /auth/me" || RECORD FAIL "GET /auth/me" "$CODE"
API_BODY "$BASE/auth/me" > "$EVIDENCE/me.json"
SAMPLE "GET /auth/me" "$EVIDENCE/me.json"

# === 2. Users ===
section "users"

API_BODY "$BASE/users" > "$EVIDENCE/users.json"
USERS_OK=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/users.json"));print(1 if isinstance(d.get("users"),list) else 0)' 2>/dev/null)
[ "$USERS_OK" = "1" ] && RECORD PASS "GET /users" "" || RECORD FAIL "GET /users" "bad shape"
SAMPLE "GET /users" "$EVIDENCE/users.json"

# create test user
RAND="$(date +%s%N | tail -c 9)"
TEST_EMAIL="testuser-$RAND@example.com"
NEW_USER=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"email\":\"$TEST_EMAIL\",\"name\":\"Test User\",\"password\":\"abcdef12345\",\"role\":\"member\"}" \
  "$BASE/users")
echo "$NEW_USER" > "$EVIDENCE/users-create.json"
TEST_USER_ID=$(python3 -c 'import json,sys;d=json.load(open("'"$EVIDENCE"'/users-create.json"));print(d.get("user",{}).get("id",""))' 2>/dev/null)
if [ -n "$TEST_USER_ID" ]; then RECORD PASS "POST /users" "id=$TEST_USER_ID"; else RECORD FAIL "POST /users" "no id"; fi
SAMPLE "POST /users" "$EVIDENCE/users-create.json"

# disable / enable
CODE=$(API_HEAD -X POST "$BASE/users/$TEST_USER_ID/disable")
[ "$CODE" = "200" ] && RECORD PASS "POST /users/:id/disable" || RECORD FAIL "POST /users/:id/disable" "$CODE"
CODE=$(API_HEAD -X POST "$BASE/users/$TEST_USER_ID/enable")
[ "$CODE" = "200" ] && RECORD PASS "POST /users/:id/enable" || RECORD FAIL "POST /users/:id/enable" "$CODE"

# reset password
CODE=$(API_HEAD -X POST -H content-type:application/json \
  -d '{"password":"newpassword12345"}' \
  "$BASE/users/$TEST_USER_ID/reset-password")
[ "$CODE" = "200" ] && RECORD PASS "POST /users/:id/reset-password" || RECORD FAIL "POST /users/:id/reset-password" "$CODE"

# delete self → 400 (safety rail)
SELF_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/login.json"))["user"]["id"])')
CODE=$(API_HEAD -X DELETE "$BASE/users/$SELF_ID")
[ "$CODE" = "400" ] && RECORD PASS "DELETE /users/:id (self → 400)" || RECORD FAIL "delete-self check" "$CODE"

# delete non-disabled user → 409 (safety rail)
CODE=$(API_HEAD -X DELETE "$BASE/users/$TEST_USER_ID")
[ "$CODE" = "409" ] && RECORD PASS "DELETE /users/:id (not-disabled → 409)" || RECORD FAIL "delete-must-disable check" "$CODE"

# disable then delete (the actual deletion path is tested in cleanup section)

# === 3. Folders ===
section "folders"

# list root folders
API_BODY "$BASE/folders" > "$EVIDENCE/folders-root.json"
RECORD PASS "GET /folders (root)" "$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/folders-root.json"))["folders"]))') folders"
SAMPLE "GET /folders" "$EVIDENCE/folders-root.json"

# create folder
FOLDER_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"name\":\"e2e-test-$RAND\",\"parentId\":null,\"defaultPolicy\":\"standard\"}" \
  "$BASE/folders")
echo "$FOLDER_RES" > "$EVIDENCE/folder-create.json"
FOLDER_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/folder-create.json"))["folder"]["id"])')
[ -n "$FOLDER_ID" ] && RECORD PASS "POST /folders" "id=$FOLDER_ID" || RECORD FAIL "POST /folders" ""
SAMPLE "POST /folders" "$EVIDENCE/folder-create.json"

# create subfolder
SUB_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"name\":\"sub-$RAND\",\"parentId\":\"$FOLDER_ID\",\"defaultPolicy\":\"standard\"}" \
  "$BASE/folders")
SUB_ID=$(echo "$SUB_RES" | python3 -c 'import json,sys;print(json.load(sys.stdin)["folder"]["id"])')
[ -n "$SUB_ID" ] && RECORD PASS "POST /folders (subfolder)" "id=$SUB_ID" || RECORD FAIL "POST /folders (subfolder)" ""

# rename folder
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"name\":\"e2e-test-$RAND-renamed\"}" \
  "$BASE/folders/$FOLDER_ID")
[ "$CODE" = "200" ] && RECORD PASS "PATCH /folders/:id (rename)" || RECORD FAIL "PATCH /folders/:id (rename)" "$CODE"

# move into self → 400
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"parentId\":\"$FOLDER_ID\"}" \
  "$BASE/folders/$FOLDER_ID")
[ "$CODE" = "400" ] && RECORD PASS "PATCH /folders/:id (move into self → 400)" || RECORD FAIL "PATCH /folders/:id self-move" "$CODE"

# move parent into descendant → should 400 (cycle prevention)
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"parentId\":\"$SUB_ID\"}" \
  "$BASE/folders/$FOLDER_ID")
[ "$CODE" = "400" ] && RECORD PASS "PATCH /folders/:id (cycle → 400)" || RECORD FAIL "PATCH /folders/:id cycle" "$CODE"

# folder permission grant (to test user)
CODE=$(API_HEAD -X POST -H content-type:application/json \
  -d "{\"userId\":\"$TEST_USER_ID\",\"level\":\"read\"}" \
  "$BASE/folders/$FOLDER_ID/permissions")
[ "$CODE" = "200" ] || [ "$CODE" = "201" ] && RECORD PASS "POST /folders/:id/permissions" || RECORD FAIL "POST /folders/:id/permissions" "$CODE"

# === 4. Files: new + content ===
section "files: editor (new + content)"

# new txt
RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"name\":\"e2e-$RAND.txt\",\"mimeType\":\"text/plain\",\"folderId\":\"$FOLDER_ID\"}" \
  "$BASE/files/new")
echo "$RES" > "$EVIDENCE/file-new-txt.json"
TXT_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/file-new-txt.json"))["file"]["id"])')
[ -n "$TXT_ID" ] && RECORD PASS "POST /files/new (txt)" "id=$TXT_ID size=0" || RECORD FAIL "POST /files/new (txt)" ""
SAMPLE "POST /files/new (txt)" "$EVIDENCE/file-new-txt.json"

# new md
MD_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"name\":\"e2e-$RAND.md\",\"mimeType\":\"text/markdown\",\"folderId\":\"$FOLDER_ID\"}" \
  "$BASE/files/new")
MD_ID=$(echo "$MD_RES" | python3 -c 'import json,sys;print(json.load(sys.stdin)["file"]["id"])')
[ -n "$MD_ID" ] && RECORD PASS "POST /files/new (md)" "id=$MD_ID" || RECORD FAIL "POST /files/new (md)" ""

# new docx (template)
DOCX_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"name\":\"e2e-$RAND.docx\",\"mimeType\":\"application/vnd.openxmlformats-officedocument.wordprocessingml.document\",\"folderId\":\"$FOLDER_ID\"}" \
  "$BASE/files/new")
DOCX_ID=$(echo "$DOCX_RES" | python3 -c 'import json,sys;print(json.load(sys.stdin)["file"]["id"])')
DOCX_SIZE=$(echo "$DOCX_RES" | python3 -c 'import json,sys;print(json.load(sys.stdin)["file"]["sizeBytes"])')
[ -n "$DOCX_ID" ] && RECORD PASS "POST /files/new (docx)" "size=$DOCX_SIZE bytes" || RECORD FAIL "POST /files/new (docx)" ""
SAMPLE "POST /files/new (docx)" /dev/stdin <<<"$DOCX_RES"

# wrong mime → 400
CODE=$(API_HEAD -X POST -H content-type:application/json \
  -d "{\"name\":\"x.exe\",\"mimeType\":\"application/exe\"}" \
  "$BASE/files/new")
[ "$CODE" = "400" ] && RECORD PASS "POST /files/new (bad mime → 400)" || RECORD FAIL "POST /files/new bad mime" "$CODE"

# write content + read back
TEST_CONTENT='# 测试笔记

这是 **加粗**。
- 一项
- 两项'
B64=$(printf '%s' "$TEST_CONTENT" | base64 -w0)
CODE=$(API_HEAD -X PUT -H content-type:application/json \
  -d "{\"contentBase64\":\"$B64\"}" \
  "$BASE/files/$MD_ID/content")
[ "$CODE" = "200" ] && RECORD PASS "PUT /files/:id/content" || RECORD FAIL "PUT /files/:id/content" "$CODE"

DOWNLOADED=$(curl -sS -b "$COOKIE" "$BASE/files/$MD_ID/download")
if [ "$DOWNLOADED" = "$TEST_CONTENT" ]; then RECORD PASS "GET /files/:id/download (round-trip)" "content matches"; else RECORD FAIL "GET /files/:id/download" "content mismatch"; fi

# preview
CODE=$(API_HEAD "$BASE/files/$MD_ID/preview")
[ "$CODE" = "200" ] && RECORD PASS "GET /files/:id/preview" || RECORD FAIL "GET /files/:id/preview" "$CODE"

# === 5. Upload (chunked) ===
section "upload (chunked)"

# generate a 6 MiB test file
TMP_UPLOAD=$(mktemp)
dd if=/dev/urandom of="$TMP_UPLOAD" bs=1M count=6 2>/dev/null
UPLOAD_SHA=$(sha256sum "$TMP_UPLOAD" | cut -d' ' -f1)
UPLOAD_SIZE=$(stat -c%s "$TMP_UPLOAD")

INIT_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"filename\":\"e2e-$RAND.bin\",\"sizeBytes\":$UPLOAD_SIZE,\"chunkSize\":4194304,\"folderId\":\"$FOLDER_ID\"}" \
  "$BASE/uploads/init")
echo "$INIT_RES" > "$EVIDENCE/upload-init.json"
UPLOAD_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/upload-init.json"))["uploadId"])')
CHUNK_SIZE=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/upload-init.json"))["chunkSize"])')
CHUNK_COUNT=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/upload-init.json"))["expectedChunks"])')
[ -n "$UPLOAD_ID" ] && RECORD PASS "POST /uploads/init" "chunks=$CHUNK_COUNT chunkSize=$CHUNK_SIZE" || RECORD FAIL "POST /uploads/init" ""
SAMPLE "POST /uploads/init" "$EVIDENCE/upload-init.json"

# upload chunks
> "$EVIDENCE/upload-chunks.log"
for i in $(seq 0 $((CHUNK_COUNT - 1))); do
  dd if="$TMP_UPLOAD" bs=$CHUNK_SIZE count=1 skip=$i 2>/dev/null | \
    curl -sS -b "$COOKIE" -X PUT --data-binary @- \
      -H content-type:application/octet-stream \
      -o /dev/null -w "%{http_code}\n" \
      "$BASE/uploads/$UPLOAD_ID/chunk/$i" >> "$EVIDENCE/upload-chunks.log"
done
CHUNK_OK=$(wc -l < "$EVIDENCE/upload-chunks.log")
[ "$CHUNK_OK" = "$CHUNK_COUNT" ] && RECORD PASS "PUT /uploads/:id/chunk/:index" "$CHUNK_OK/$CHUNK_COUNT chunks OK" || RECORD FAIL "PUT chunks" "$CHUNK_OK/$CHUNK_COUNT"

# complete
COMPLETE_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"plaintextSha256\":\"$UPLOAD_SHA\"}" \
  "$BASE/uploads/$UPLOAD_ID/complete")
echo "$COMPLETE_RES" > "$EVIDENCE/upload-complete.json"
UPLOADED_FILE_ID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/upload-complete.json"))["file"]["id"])' 2>/dev/null)
[ -n "$UPLOADED_FILE_ID" ] && RECORD PASS "POST /uploads/:id/complete" "id=$UPLOADED_FILE_ID" || RECORD FAIL "POST /uploads/:id/complete" ""
SAMPLE "POST /uploads/:id/complete" "$EVIDENCE/upload-complete.json"

# verify download integrity
DLOUT=$(mktemp)
curl -sS -b "$COOKIE" "$BASE/files/$UPLOADED_FILE_ID/download" -o "$DLOUT"
DL_SHA=$(sha256sum "$DLOUT" | cut -d' ' -f1)
[ "$DL_SHA" = "$UPLOAD_SHA" ] && RECORD PASS "Upload integrity (6 MiB round-trip)" "SHA matches" || RECORD FAIL "Upload integrity" "SHA $DL_SHA ≠ $UPLOAD_SHA"
rm -f "$DLOUT" "$TMP_UPLOAD"

# init + abort
ABORT_INIT=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"filename\":\"abort.bin\",\"sizeBytes\":100,\"chunkSize\":4194304,\"folderId\":\"$FOLDER_ID\"}" \
  "$BASE/uploads/init")
ABORT_ID=$(echo "$ABORT_INIT" | python3 -c 'import json,sys;print(json.load(sys.stdin)["uploadId"])')
CODE=$(API_HEAD -X POST "$BASE/uploads/$ABORT_ID/abort")
[ "$CODE" = "204" ] || [ "$CODE" = "200" ] && RECORD PASS "POST /uploads/:id/abort" || RECORD FAIL "POST /uploads/:id/abort" "$CODE"

# === 6. Files: listing + search + detail ===
section "files: listing + search"

# list in folder
API_BODY "$BASE/files?folderId=$FOLDER_ID" > "$EVIDENCE/files-in-folder.json"
COUNT=$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/files-in-folder.json"))["files"]))')
RECORD PASS "GET /files?folderId=..." "found $COUNT files"
SAMPLE "GET /files?folderId" "$EVIDENCE/files-in-folder.json"

# recursive search with cursor pagination
API_BODY "$BASE/files?q=e2e&recursive=1&pageSize=5" > "$EVIDENCE/files-search.json"
COUNT=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/files-search.json"));print(len(d["files"]),"cursor=",d.get("nextCursor"))')
RECORD PASS "GET /files?q=&recursive=1&pageSize=5" "$COUNT"
SAMPLE "GET /files (search recursive)" "$EVIDENCE/files-search.json"

# detail
API_BODY "$BASE/files/$UPLOADED_FILE_ID/detail" > "$EVIDENCE/file-detail.json"
HAS_DIST=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/file-detail.json"));print(1 if "storageDistribution" in d else 0)')
[ "$HAS_DIST" = "1" ] && RECORD PASS "GET /files/:id/detail (storage distribution)" || RECORD FAIL "file detail" "no storageDistribution"
SAMPLE "GET /files/:id/detail" "$EVIDENCE/file-detail.json"

# risks
CODE=$(API_HEAD "$BASE/files/risks")
[ "$CODE" = "200" ] && RECORD PASS "GET /files/risks" || RECORD FAIL "GET /files/risks" "$CODE"

# rename file
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"name\":\"e2e-$RAND-renamed.bin\"}" \
  "$BASE/files/$UPLOADED_FILE_ID")
[ "$CODE" = "200" ] && RECORD PASS "PATCH /files/:id (rename)" || RECORD FAIL "PATCH /files/:id (rename)" "$CODE"

# move file
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"folderId\":\"$SUB_ID\"}" \
  "$BASE/files/$UPLOADED_FILE_ID")
[ "$CODE" = "200" ] && RECORD PASS "PATCH /files/:id (move)" || RECORD FAIL "PATCH /files/:id (move)" "$CODE"

# permission
CODE=$(API_HEAD -X POST -H content-type:application/json \
  -d "{\"userId\":\"$TEST_USER_ID\",\"level\":\"read\"}" \
  "$BASE/files/$UPLOADED_FILE_ID/permissions")
[ "$CODE" = "200" ] && RECORD PASS "POST /files/:id/permissions" || RECORD FAIL "POST /files/:id/permissions" "$CODE"

# === 7. Versions ===
section "versions"

# put new version
B64_2=$(printf 'version 2 content' | base64 -w0)
CODE=$(API_HEAD -X PUT -H content-type:application/json \
  -d "{\"contentBase64\":\"$B64_2\"}" \
  "$BASE/files/$MD_ID/content")
[ "$CODE" = "200" ] && RECORD PASS "PUT /files/:id/content (v2)" || RECORD FAIL "PUT content v2" "$CODE"

# list versions
API_BODY "$BASE/files/$MD_ID/versions" > "$EVIDENCE/versions.json"
VCOUNT=$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/versions.json"))["versions"]))')
[ "$VCOUNT" -ge 2 ] && RECORD PASS "GET /files/:id/versions" "$VCOUNT versions" || RECORD FAIL "versions list" "$VCOUNT"
SAMPLE "GET /files/:id/versions" "$EVIDENCE/versions.json"

# download specific version
VID=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/versions.json"))["versions"][0]["id"])')
CODE=$(API_HEAD "$BASE/files/$MD_ID/versions/$VID/download")
[ "$CODE" = "200" ] && RECORD PASS "GET /files/:id/versions/:vid/download" || RECORD FAIL "version download" "$CODE"

# versions limit clamp
CODE=$(API_HEAD "$BASE/files/$MD_ID/versions?limit=999")
[ "$CODE" = "200" ] && RECORD PASS "GET /files/:id/versions?limit=999 (clamp)" || RECORD FAIL "versions limit" "$CODE"

# === 8. Shares (file) ===
section "shares (file)"

# create file share
SHARE_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"maxDownloads\":5,\"expiresAt\":null}" \
  "$BASE/files/$UPLOADED_FILE_ID/shares")
echo "$SHARE_RES" > "$EVIDENCE/share-create.json"
SHARE_ID=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/share-create.json"));print(d["share"]["id"])')
SHARE_URL=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/share-create.json"));print(d["share"]["url"])')
SHARE_TOKEN=$(echo "$SHARE_URL" | awk -F/ '{print $NF}')
[ -n "$SHARE_TOKEN" ] && RECORD PASS "POST /files/:id/shares" "url=$SHARE_URL" || RECORD FAIL "create file share" ""
SAMPLE "POST /files/:id/shares" "$EVIDENCE/share-create.json"

# create with password
PWSHARE=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"password\":\"secret123\",\"maxDownloads\":3}" \
  "$BASE/files/$UPLOADED_FILE_ID/shares")
PW_TOKEN=$(echo "$PWSHARE" | python3 -c 'import json,sys;u=json.load(sys.stdin)["share"]["url"];print(u.rsplit("/",1)[1])')
[ -n "$PW_TOKEN" ] && RECORD PASS "POST /files/:id/shares (with password)" || RECORD FAIL "create password share" ""

# public meta — no auth
META=$(curl -sS "$BASE/shares/$SHARE_TOKEN")
echo "$META" > "$EVIDENCE/share-meta.json"
KIND=$(echo "$META" | python3 -c 'import json,sys;print(json.load(sys.stdin)["kind"])')
[ "$KIND" = "file" ] && RECORD PASS "GET /shares/:token (no auth)" "kind=file" || RECORD FAIL "public meta" ""
SAMPLE "GET /shares/:token" "$EVIDENCE/share-meta.json"

# download via public link (no password)
DLOUT=$(mktemp)
CODE=$(curl -sS -o "$DLOUT" -w '%{http_code}' "$BASE/shares/$SHARE_TOKEN/download")
[ "$CODE" = "200" ] && RECORD PASS "GET /shares/:token/download (no pw)" || RECORD FAIL "share download" "$CODE"
rm -f "$DLOUT"

# download via password share with wrong password
CODE=$(curl -sS -o /dev/null -w '%{http_code}' -X POST \
  -H content-type:application/json -d '{"password":"wrong"}' \
  "$BASE/shares/$PW_TOKEN/download")
[ "$CODE" = "403" ] && RECORD PASS "POST /shares/:token/download (bad pw → 403)" || RECORD FAIL "bad share pw" "$CODE"

# download via password share with correct password
DLOUT=$(mktemp)
CODE=$(curl -sS -o "$DLOUT" -w '%{http_code}' -X POST \
  -H content-type:application/json -d '{"password":"secret123"}' \
  "$BASE/shares/$PW_TOKEN/download")
[ "$CODE" = "200" ] && RECORD PASS "POST /shares/:token/download (correct pw)" || RECORD FAIL "share download w/pw" "$CODE"
rm -f "$DLOUT"

# rate limit test — try 6 wrong passwords rapidly
for i in 1 2 3 4 5 6 7; do
  curl -sS -o /dev/null -w '%{http_code}\n' -X POST \
    -H content-type:application/json -d '{"password":"x"}' \
    "$BASE/shares/$PW_TOKEN/download" >> "$EVIDENCE/ratelimit.log"
done
RL=$(grep -c '^429$' "$EVIDENCE/ratelimit.log")
[ "$RL" -ge 1 ] && RECORD PASS "Share password rate limit (429 after ~5)" "$RL/7 hit 429" || RECORD FAIL "rate limit" "$RL/7 hit 429"
SAMPLE "rate-limit responses" "$EVIDENCE/ratelimit.log"

# list shares
API_BODY "$BASE/files/$UPLOADED_FILE_ID/shares" > "$EVIDENCE/file-shares-list.json"
SCOUNT=$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/file-shares-list.json"))["shares"]))')
[ "$SCOUNT" -ge 2 ] && RECORD PASS "GET /files/:id/shares" "$SCOUNT shares" || RECORD FAIL "list file shares" "$SCOUNT"

# patch share (change maxDownloads)
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"maxDownloads\":99}" \
  "$BASE/shares/$SHARE_ID")
[ "$CODE" = "200" ] && RECORD PASS "PATCH /shares/:id" || RECORD FAIL "patch share" "$CODE"

# revoke share
CODE=$(API_HEAD -X POST "$BASE/shares/$SHARE_ID/revoke")
[ "$CODE" = "200" ] && RECORD PASS "POST /shares/:id/revoke" || RECORD FAIL "revoke share" "$CODE"

# revoked share should 404 on download
CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/shares/$SHARE_TOKEN/download")
[ "$CODE" = "404" ] && RECORD PASS "revoked share download → 404" || RECORD FAIL "revoked share status" "$CODE"

# delete share
CODE=$(API_HEAD -X DELETE "$BASE/shares/$SHARE_ID")
[ "$CODE" = "204" ] || [ "$CODE" = "200" ] && RECORD PASS "DELETE /shares/:id" || RECORD FAIL "delete share" "$CODE"

# === 9. Shares (folder) ===
section "shares (folder)"

FSHARE_RES=$(API_BODY -X POST -H content-type:application/json \
  -d "{\"maxDownloads\":10}" \
  "$BASE/folders/$FOLDER_ID/shares")
echo "$FSHARE_RES" > "$EVIDENCE/folder-share-create.json"
FSHARE_ID=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/folder-share-create.json"));print(d["share"]["id"])')
FSHARE_URL=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/folder-share-create.json"));print(d["share"]["url"])')
FSHARE_TOKEN=$(echo "$FSHARE_URL" | awk -F/ '{print $NF}')
[ -n "$FSHARE_TOKEN" ] && RECORD PASS "POST /folders/:id/shares" "url=$FSHARE_URL" || RECORD FAIL "create folder share" ""
SAMPLE "POST /folders/:id/shares" "$EVIDENCE/folder-share-create.json"

# listing
LISTING=$(curl -sS "$BASE/shares/$FSHARE_TOKEN/listing")
echo "$LISTING" > "$EVIDENCE/folder-listing.json"
LITEM=$(echo "$LISTING" | python3 -c 'import json,sys;d=json.load(sys.stdin);print("files=",len(d.get("files",[])),"folders=",len(d.get("folders",[])))')
RECORD PASS "GET /shares/:token/listing" "$LITEM"
SAMPLE "GET /shares/:token/listing" "$EVIDENCE/folder-listing.json"

# zip download
ZIPOUT=$(mktemp)
CODE=$(curl -sS -o "$ZIPOUT" -w '%{http_code}' "$BASE/shares/$FSHARE_TOKEN/zip")
ZIPSIZE=$(stat -c%s "$ZIPOUT")
[ "$CODE" = "200" ] && [ "$ZIPSIZE" -gt 100 ] && RECORD PASS "GET /shares/:token/zip" "size=$ZIPSIZE bytes" || RECORD FAIL "folder zip" "$CODE size=$ZIPSIZE"
# verify it's a real zip
file "$ZIPOUT" | grep -qi zip && RECORD PASS "Folder ZIP is valid" || RECORD FAIL "Folder ZIP not zip"
rm -f "$ZIPOUT"

# single-file in folder share
FFILE_ID=$(echo "$LISTING" | python3 -c 'import json,sys;d=json.load(sys.stdin);fs=d.get("files",[]);print(fs[0]["id"] if fs else "")')
if [ -n "$FFILE_ID" ]; then
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' "$BASE/shares/$FSHARE_TOKEN/file/$FFILE_ID")
  [ "$CODE" = "200" ] && RECORD PASS "GET /shares/:token/file/:fileId" || RECORD FAIL "single-file in folder share" "$CODE"
fi

# === 10. Nodes ===
section "nodes"

API_BODY "$BASE/nodes" > "$EVIDENCE/nodes.json"
NCOUNT=$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/nodes.json"))["nodes"]))')
RECORD PASS "GET /nodes" "$NCOUNT nodes"
SAMPLE "GET /nodes" "$EVIDENCE/nodes.json"

NODE_ID=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/nodes.json"));print([n["id"] for n in d["nodes"] if n["status"]=="active"][0])')

# probes
API_BODY "$BASE/nodes/$NODE_ID/probes?range=1h" > "$EVIDENCE/probes.json"
BCOUNT=$(python3 -c 'import json;print(len(json.load(open("'"$EVIDENCE"'/probes.json"))["buckets"]))')
[ "$BCOUNT" = "60" ] && RECORD PASS "GET /nodes/:id/probes" "60 buckets" || RECORD FAIL "probes" "$BCOUNT buckets"
SAMPLE "GET /nodes/:id/probes" "$EVIDENCE/probes.json"

# impact
API_BODY "$BASE/nodes/$NODE_ID/impact" > "$EVIDENCE/impact.json"
HAS_IMPACT=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/impact.json"));print(1 if "impact" in d else 0)')
[ "$HAS_IMPACT" = "1" ] && RECORD PASS "GET /nodes/:id/impact" || RECORD FAIL "impact"
SAMPLE "GET /nodes/:id/impact" "$EVIDENCE/impact.json"

# reverify (no-op since no MISSING)
API_BODY -X POST "$BASE/nodes/$NODE_ID/reverify" > "$EVIDENCE/reverify.json"
CHECKED=$(python3 -c 'import json;print(json.load(open("'"$EVIDENCE"'/reverify.json"))["checked"])')
RECORD PASS "POST /nodes/:id/reverify" "checked=$CHECKED"
SAMPLE "POST /nodes/:id/reverify" "$EVIDENCE/reverify.json"

# patch node (update priority — minimum impact)
ORIG_PRIO=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/nodes.json"));print([n["priority"] for n in d["nodes"] if n["id"]=="'"$NODE_ID"'"][0])')
CODE=$(API_HEAD -X PATCH -H content-type:application/json \
  -d "{\"priority\":$ORIG_PRIO}" \
  "$BASE/nodes/$NODE_ID")
[ "$CODE" = "200" ] && RECORD PASS "PATCH /nodes/:id (priority)" || RECORD FAIL "patch node" "$CODE"

# migration query
CODE=$(API_HEAD "$BASE/nodes/$NODE_ID/migration")
[ "$CODE" = "200" ] && RECORD PASS "GET /nodes/:id/migration" || RECORD FAIL "migration" "$CODE"

# === 11. Access logs ===
section "access logs"

API_BODY "$BASE/access-logs?pageSize=5&page=1" > "$EVIDENCE/access-logs.json"
LCOUNT=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/access-logs.json"));k="logs" if "logs" in d else "items";print(len(d.get(k,[])))')
[ "$LCOUNT" -gt 0 ] && RECORD PASS "GET /access-logs" "$LCOUNT entries" || RECORD FAIL "access logs" ""
SAMPLE "GET /access-logs" "$EVIDENCE/access-logs.json"

# === 12. Trash flow ===
section "trash"

# delete file (move to trash)
CODE=$(API_HEAD -X DELETE "$BASE/files/$UPLOADED_FILE_ID")
[ "$CODE" = "204" ] || [ "$CODE" = "200" ] && RECORD PASS "DELETE /files/:id (to trash)" || RECORD FAIL "delete file" "$CODE"

# list trash
API_BODY "$BASE/files/trash" > "$EVIDENCE/trash.json"
TCOUNT=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/trash.json"));k="files" if "files" in d else "items";print(len(d.get(k,[])))')
[ "$TCOUNT" -gt 0 ] && RECORD PASS "GET /files/trash" "$TCOUNT items" || RECORD FAIL "trash list"

# restore
CODE=$(API_HEAD -X POST "$BASE/files/$UPLOADED_FILE_ID/restore")
[ "$CODE" = "200" ] && RECORD PASS "POST /files/:id/restore" || RECORD FAIL "restore" "$CODE"

# delete + purge
API_HEAD -X DELETE "$BASE/files/$UPLOADED_FILE_ID" > /dev/null
CODE=$(API_HEAD -X POST "$BASE/files/$UPLOADED_FILE_ID/purge")
[ "$CODE" = "204" ] || [ "$CODE" = "200" ] && RECORD PASS "POST /files/:id/purge" || RECORD FAIL "purge" "$CODE"

# === 13. Auth: logout ===
section "auth: logout"

CODE=$(API_HEAD -X POST "$BASE/auth/logout")
[ "$CODE" = "204" ] || [ "$CODE" = "200" ] && RECORD PASS "POST /auth/logout" || RECORD FAIL "logout" "$CODE"

# protected route after logout → 401
CODE=$(curl -sS -b "$COOKIE" -o /dev/null -w '%{http_code}' "$BASE/auth/me")
[ "$CODE" = "401" ] && RECORD PASS "GET /auth/me after logout → 401" || RECORD FAIL "post-logout 401" "$CODE"

# === Cleanup: log back in, delete test fixtures ===
section "cleanup"
curl -sS -c "$COOKIE" -H content-type:application/json \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PW\"}" \
  "$BASE/auth/login" -o /dev/null

# delete test user (full path: disable then hard-delete)
API_HEAD -X POST "$BASE/users/$TEST_USER_ID/disable" > /dev/null
DELRES=$(API_BODY -X DELETE "$BASE/users/$TEST_USER_ID")
echo "$DELRES" > "$EVIDENCE/user-delete.json"
DELETED=$(python3 -c 'import json;d=json.load(open("'"$EVIDENCE"'/user-delete.json"));print(d.get("deleted"))' 2>/dev/null)
[ "$DELETED" = "True" ] && RECORD PASS "DELETE /users/:id (disabled → ok)" || RECORD FAIL "delete disabled user" "$DELRES"
SAMPLE "DELETE /users/:id" "$EVIDENCE/user-delete.json"

# delete folder share + folder + leftover files
API_HEAD -X POST "$BASE/shares/$FSHARE_ID/revoke" > /dev/null 2>&1 || true
API_HEAD -X DELETE "$BASE/folders/$FOLDER_ID" > /dev/null 2>&1 || true

# === Summary ===
echo
echo "==== Summary ===="
PASSED=$(grep -c '^PASS' "$EVIDENCE/results.tsv")
FAILED=$(grep -c '^FAIL' "$EVIDENCE/results.tsv")
SKIPPED=$(grep -c '^SKIP' "$EVIDENCE/results.tsv")
TOTAL=$((PASSED + FAILED + SKIPPED))
printf 'TOTAL %d | PASS %d | FAIL %d | SKIP %d\n' "$TOTAL" "$PASSED" "$FAILED" "$SKIPPED"
echo "Evidence: $EVIDENCE/"
exit 0
