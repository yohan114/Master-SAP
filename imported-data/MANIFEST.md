# MANIFEST — imported-data snapshot

Generated from `app/umms.sqlite` on 2026-07-14. **16,913 data rows across 10 tables.**
Verify a file after download with `sha256sum <file>` (or `shasum -a 256 <file>` on macOS).

## Database

| File | Tables | SHA-256 |
|------|-------:|---------|
| `db/umms-imported-data.sqlite` | 10 | `c9251b6747681ae17d0181fc889e0813f0e619b2b6b6350880a43b5f81a59380` |

## Per-table CSV (lossless, `SELECT *`)

| File | Rows | SHA-256 |
|------|-----:|---------|
| `csv/wk_job_card.csv`     | 3053 | `61879add1ed5f04242cbf357378033a92555a073b070003b5723dbbc880507d0` |
| `csv/wk_asset.csv`        |  557 | `1338c0483b4a99ee91a2e93a5c2269a498e0dfc278a100c1354baab5b5ee2272` |
| `csv/wk_site.csv`         |  114 | `60c8728611547d46898ff3eb0f2b9719653006db4502edb598af1300735f78cf` |
| `csv/import_warnings.csv` | 1095 | `9e57d813b0cd2c8251c9ab6aa980396b8878bc5b0591ff43725afd56093683ed` |
| `csv/stg_mrn.csv`         | 1341 | `32de65f4e3a9c6d2f022f72d5b7b3d99a49661ea4f0020ab9e14b19ef73c7bd5` |
| `csv/stg_mrn_line.csv`    | 3967 | `6db6a8d42538e4d6f5b6014f3a7b55325917019112c88393f4258495c0d5ea2c` |
| `csv/stg_grn.csv`         | 3188 | `500eafde581bf659ea97595e94c965c26e81836f282f5651595b0a7286060252` |
| `csv/stg_mrn_item.csv`    | 2732 | `d7e048db52b379426d0abaa30dc8d72a4415bf76b1b94162675cbdc543994ac0` |
| `csv/stg_mrn_asset.csv`   |  779 | `7f35a64c029a1a6178cbd168b1092f8cb926affee9d0f55873233f912f319f8e` |
| `csv/stg_import_log.csv`  |   87 | `ad5d20d3114eb1df3df738ac507c22557ef2f828f40bd95845d961756dca8021` |

## Human-friendly joined views

| File | Rows | SHA-256 |
|------|-----:|---------|
| `reports/01_job_records.csv`      | 3053 | `91ce654c45046ef610597a9895dbe7936530df0aa8fc481deebfa77d4472d30d` |
| `reports/02_mrn_lines.csv`        | 3967 | `4c2d621a9f2a9e33a8601e7973f069738b665b689c85e5306619a79a9744d6af` |
| `reports/03_mrn_receipts.csv`     | 3188 | `10e623fafb4d2b316b9faa46dd3bb916aa3ccb770d294d45f270abc3872f75ef` |
| `reports/migration-report-mrn.csv`| 4053 | `75ec76ccfadbf389f53554546191a61fa211a2ffbbf450e20b4c3a7eb1fe8bfe` |
