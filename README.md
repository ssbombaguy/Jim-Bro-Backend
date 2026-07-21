# jim-bro-backend

Backend API for Jim-bro.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL and JWT_SECRET
npm run migrate
npm run dev
```

## Endpoints

- `POST /auth/register` — create an account
- `POST /auth/login` — log in, returns a JWT
- `GET /auth/me` — current user (requires `Authorization: Bearer <token>`)
- `POST /auth/me/avatar` — upload a profile image (`multipart/form-data`, field `avatar`; requires auth)

## Deploying (Render)

This repo includes a `render.yaml` blueprint.

1. On [Render](https://dashboard.render.com), **New → Blueprint**, connect this GitHub repo.
2. When prompted, set `DATABASE_URL` to your Neon connection string (`JWT_SECRET` is auto-generated).
3. Deploy. Render runs the migration automatically on each deploy (`npm run migrate && npm start`).

Note: the free plan's disk is ephemeral, so files under `uploads/` (profile avatars) are lost on
every redeploy/restart. Fine for testing; swap to S3/Cloudinary or a Render persistent disk before
relying on uploaded avatars sticking around.
