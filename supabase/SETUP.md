# 🔐 모두의 네컷 — 서버 설정 안내서

로그인·공유·하트 투표를 켜려면 **한 번만** 아래를 하면 됩니다. (약 20분, 비용 0원)
설정 전에도 사이트는 예전처럼 동작해요. (`config.js`가 비어 있으면 로그인 없이 동작)

---

## 1단계. Supabase 프로젝트 만들기

1. https://supabase.com → **Start your project** → GitHub 계정으로 가입
2. **New project**
   - Name: `comic-diary`
   - Database Password: 아무거나 길게 (어딘가 적어 두기)
   - Region: **Northeast Asia (Seoul)**
3. 1~2분 기다리면 완성

## 2단계. 표·보안 규칙 만들기

1. 왼쪽 메뉴 **SQL Editor** → **New query**
2. 이 저장소의 `supabase/setup.sql` 내용을 **통째로** 붙여넣기 → **Run**
3. `Success` 가 나오면 끝 (여러 번 실행해도 안전해요)

## 3단계. 구글 로그인 켜기

### 3-1. 구글 쪽 (Google Cloud Console)
1. https://console.cloud.google.com → 위쪽에서 **새 프로젝트** 만들기 (`comic-diary`)
2. **API 및 서비스 → OAuth 동의 화면**
   - 사용자 유형: **외부**
   - 앱 이름: `네컷일기`, 지원 이메일·개발자 이메일: 서비님 메일
   - 범위(scope)는 기본(email, profile)만 — 추가하지 않기
   - 다 만든 뒤 **앱 게시(프로덕션으로 푸시)** 를 눌러야 아무나 로그인할 수 있어요 (테스트 상태면 등록한 사람만 됨)
3. **API 및 서비스 → 사용자 인증 정보 → + 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 JavaScript 원본:
     - `https://4cut-diary.vercel.app`
     - `https://gsahn26.github.io`
     - `http://127.0.0.1:8930`
   - 승인된 리디렉션 URI: **`https://<내프로젝트ID>.supabase.co/auth/v1/callback`**
     (Supabase의 Google 설정 화면에 이 주소가 그대로 나와 있어요 — 복사해서 붙이기)
4. 만들기 → **클라이언트 ID** 와 **클라이언트 보안 비밀번호** 복사

### 3-2. Supabase 쪽
1. **Authentication → Sign In / Providers → Google** → Enable 켜기
2. 위에서 복사한 Client ID, Client Secret 붙여넣기 → Save
3. **Authentication → URL Configuration**
   - Site URL: `https://4cut-diary.vercel.app`
   - Redirect URLs (Add URL로 하나씩):
     - `https://4cut-diary.vercel.app/**`
     - `https://gsahn26.github.io/comic-diary/**`
     - `http://127.0.0.1:8930/**`

## 4단계. 사이트에 연결 정보 넣기

1. Supabase **Project Settings → API Keys** (또는 Data API)
2. **Project URL** 과 **anon public 키**(또는 `sb_publishable_…` 키) 복사
3. 저장소의 `config.js` 에 붙여넣기

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

> ⚠️ **`service_role` / `sb_secret_…` 키는 절대 넣지 마세요.** 모든 보안 규칙을 무시하는 관리자 키예요.
> anon 키는 공개돼도 괜찮아요 — 보안은 2단계에서 만든 DB 규칙(RLS)이 지켜요.

4. 커밋·푸시 → Vercel이 자동으로 다시 배포

## 5단계. 나를 관리자로 등록

1. 배포된 사이트에서 **구글 로그인을 한 번** 하기
2. Supabase **SQL Editor** 에서 이메일만 바꿔 실행

```sql
insert into public.admins (user_id)
  select id from auth.users where email = '서비님-구글-이메일@gmail.com'
on conflict do nothing;
```

3. 사이트 새로고침 → 이름 앞에 👑 가 보이면 성공. 이제 모든 작품에 🗑 삭제, 숨기기/숨김 풀기 버튼이 보여요.

---

## 확인 목록

- [ ] 로그인 안 한 상태: "모두의 네컷" 구경 가능, 하트 누르면 로그인 안내
- [ ] 로그인 안 한 상태: "AI로 4컷 나누기" 누르면 로그인 안내, 로그인 후 쓰던 일기 그대로
- [ ] 완성 → 🌏 공유하기 → 모두에게 공개 → 인기순/최신순에 보임
- [ ] 🔒 나만 보기로 올린 것 → 다른 계정에서 안 보임
- [ ] 다른 계정으로 하트 → 숫자 +1, 다시 누르면 -1
- [ ] 다른 계정 3개로 신고 → 자동 숨김 → 관리자가 "숨김 풀기"

## 알아 둘 점

- **무료 한도:** DB 500MB, 파일 1GB. 네컷 한 장이 약 200~300KB라 3천~4천 장쯤 저장 가능
- **무료 프로젝트는 1주일 동안 아무도 안 쓰면 일시정지**돼요. 대시보드에서 Restore 누르면 다시 켜짐
- 우리나라에서 **만 14세 미만은 보호자 동의(Family Link)** 가 있어야 구글 계정을 만들 수 있어요. 주일학교 아이들은 보호자 계정이나 선생님 계정으로 올리는 방법도 생각해 두세요
