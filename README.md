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
