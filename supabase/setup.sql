-- =====================================================================
-- 네컷일기 · 모두의 네컷 (로그인 · 공유 · 하트 투표 · 신고)
-- Supabase 대시보드 → SQL Editor 에 통째로 붙여넣고 Run 한 번.
-- 여러 번 실행해도 안전하게 만들었습니다.
--
-- 보안 원칙
--  * 모든 표에 RLS(행 보안)를 켬. 화면 코드가 아니라 DB가 직접 막음.
--  * 하트 수·신고 수·숨김은 사용자가 직접 못 바꿈(트리거만 바꿈).
--  * "나만 보기" 그림은 비공개 저장소 + 권한 있는 사람만 임시 주소 발급.
--  * 일기 원문은 저장하지 않음. 완성 그림·제목·닉네임만.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- 1. 표 만들기 ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.comics (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title        text not null check (char_length(title) between 1 and 30),
  nickname     text not null check (char_length(nickname) between 1 and 20),
  image_path   text not null unique,
  is_public    boolean not null default true,
  like_count   integer not null default 0,
  report_count integer not null default 0,
  is_hidden    boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists comics_popular_idx on public.comics (like_count desc, created_at desc);
create index if not exists comics_recent_idx  on public.comics (created_at desc);
create index if not exists comics_user_idx    on public.comics (user_id, created_at desc);

create table if not exists public.likes (
  comic_id   uuid not null references public.comics(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (comic_id, user_id)
);
create index if not exists likes_user_idx on public.likes (user_id);

create table if not exists public.reports (
  comic_id   uuid not null references public.comics(id) on delete cascade,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  reason     text check (reason is null or char_length(reason) <= 100),
  created_at timestamptz not null default now(),
  primary key (comic_id, user_id)
);

-- ---------- 2. 관리자인지 확인하는 함수 ----------
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

-- ---------- 3. 트리거: 올릴 때 값 강제 + 하루 10개 제한 ----------
create or replace function public.comics_before_insert()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception '로그인이 필요해요';
  end if;
  new.user_id      := auth.uid();      -- 남 대신 올리기 금지
  new.like_count   := 0;               -- 하트 수 조작 금지
  new.report_count := 0;
  new.is_hidden    := false;
  new.created_at   := now();
  new.title        := btrim(new.title);
  new.nickname     := btrim(new.nickname);
  if split_part(new.image_path, '/', 1) <> auth.uid()::text then
    raise exception '그림 경로가 올바르지 않아요';
  end if;
  if (select count(*) from public.comics
       where user_id = auth.uid() and created_at > now() - interval '1 day') >= 10 then
    raise exception '하루에 10개까지만 올릴 수 있어요';
  end if;
  return new;
end $$;

drop trigger if exists comics_before_insert on public.comics;
create trigger comics_before_insert before insert on public.comics
  for each row execute function public.comics_before_insert();

-- ---------- 4. 트리거: 하트 수 자동 계산 ----------
create or replace function public.likes_count()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update public.comics set like_count = like_count + 1 where id = new.comic_id;
  elsif tg_op = 'DELETE' then
    update public.comics set like_count = greatest(like_count - 1, 0) where id = old.comic_id;
  end if;
  return null;
end $$;

drop trigger if exists likes_count on public.likes;
create trigger likes_count after insert or delete on public.likes
  for each row execute function public.likes_count();

-- ---------- 5. 트리거: 신고 3번이면 자동 숨김 ----------
create or replace function public.reports_count()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  update public.comics
     set report_count = report_count + 1,
         is_hidden    = is_hidden or (report_count + 1 >= 3)
   where id = new.comic_id;
  return null;
end $$;

drop trigger if exists reports_count on public.reports;
create trigger reports_count after insert on public.reports
  for each row execute function public.reports_count();

-- ---------- 6. 함수: 공개 여부 바꾸기(내 것), 숨김 풀기/걸기(관리자) ----------
create or replace function public.set_comic_public(p_id uuid, p_public boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  update public.comics set is_public = p_public
   where id = p_id and user_id = auth.uid();
  if not found then raise exception '내 작품만 바꿀 수 있어요'; end if;
end $$;

create or replace function public.admin_set_hidden(p_id uuid, p_hidden boolean)
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_admin() then raise exception '관리자만 할 수 있어요'; end if;
  update public.comics
     set is_hidden = p_hidden,
         report_count = case when p_hidden then report_count else 0 end
   where id = p_id;
  if not p_hidden then delete from public.reports where comic_id = p_id; end if;
end $$;

revoke all on function public.set_comic_public(uuid, boolean) from public, anon;
revoke all on function public.admin_set_hidden(uuid, boolean) from public, anon;
grant execute on function public.set_comic_public(uuid, boolean) to authenticated;
grant execute on function public.admin_set_hidden(uuid, boolean) to authenticated;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- 7. 행 보안(RLS) ----------
alter table public.admins  enable row level security;   -- 정책 없음 = API로 아무도 못 읽고 못 씀
alter table public.comics  enable row level security;
alter table public.likes   enable row level security;
alter table public.reports enable row level security;

-- 작품: 공개+안숨김은 누구나, 내 것은 나, 관리자는 전부
drop policy if exists comics_select on public.comics;
create policy comics_select on public.comics for select
  using ((is_public and not is_hidden) or user_id = auth.uid() or public.is_admin());

drop policy if exists comics_insert on public.comics;
create policy comics_insert on public.comics for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists comics_delete on public.comics;
create policy comics_delete on public.comics for delete to authenticated
  using (user_id = auth.uid() or public.is_admin());
-- update 정책 없음 → 직접 수정 불가(하트 수 조작 방지). 공개 여부는 set_comic_public 함수로만.

-- 하트: 내 하트만 보고/누르고/취소. 볼 수 있는 작품에만 누를 수 있음.
drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes for select to authenticated
  using (user_id = auth.uid());
drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.comics c where c.id = comic_id));
drop policy if exists likes_delete on public.likes;
create policy likes_delete on public.likes for delete to authenticated
  using (user_id = auth.uid());

-- 신고: 내 신고만 보고/넣기. 취소 없음.
drop policy if exists reports_select on public.reports;
create policy reports_select on public.reports for select to authenticated
  using (user_id = auth.uid());
drop policy if exists reports_insert on public.reports;
create policy reports_insert on public.reports for insert to authenticated
  with check (user_id = auth.uid()
              and exists (select 1 from public.comics c where c.id = comic_id));

-- 표 권한(정책과 함께 써야 동작)
grant select on public.comics to anon, authenticated;
grant insert, delete on public.comics to authenticated;
grant select, insert, delete on public.likes to authenticated;
grant select, insert on public.reports to authenticated;
revoke update on public.comics from anon, authenticated;

-- ---------- 8. 그림 저장소(비공개 버킷, 2MB, jpg/png만) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('comics', 'comics', false, 2097152, array['image/jpeg', 'image/png'])
on conflict (id) do update
  set public = false, file_size_limit = 2097152, allowed_mime_types = array['image/jpeg', 'image/png'];

-- 올리기: 로그인한 사람이 "내 아이디/" 폴더에만
drop policy if exists comics_obj_insert on storage.objects;
create policy comics_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'comics' and (storage.foldername(name))[1] = auth.uid()::text);

-- 보기(임시 주소 발급): 그 그림의 작품을 볼 수 있는 사람만 (위 comics 규칙을 그대로 따름)
drop policy if exists comics_obj_select on storage.objects;
create policy comics_obj_select on storage.objects for select
  using (bucket_id = 'comics'
         and exists (select 1 from public.comics c where c.image_path = objects.name));

-- 지우기: 내 폴더 것 또는 관리자
drop policy if exists comics_obj_delete on storage.objects;
create policy comics_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'comics'
         and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- ---------- 9. 관리자 등록 (구글 로그인을 한 번 한 뒤, 이메일만 바꿔서 실행) ----------
-- insert into public.admins (user_id)
--   select id from auth.users where email = '여기에-관리자-구글-이메일@gmail.com'
-- on conflict do nothing;
