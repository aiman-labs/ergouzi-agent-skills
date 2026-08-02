# Image Model Reference

This is the objective request contract verified from the live model schemas on
2026-08-02. The server remains the source of truth and returns validation errors
for unsupported fields.

All models use:

```text
POST /customer/v1/models/{owner}/{model}/predictions
Authorization: Bearer <Ergouzi API key>
Content-Type: application/json

{"input": { ...model fields... }}
```

The Skill accepts documented media fields as HTTPS URLs, supported base64 data
URIs, or local `$local_file` objects. It validates local file signatures before
converting them to data URIs. The final JSON request must remain within 4 MiB;
use HTTPS URLs for larger media. All five models return one image URI;
successful downloads must be JPEG, PNG, or WebP.

## `ergouzi/e-image`

Required: `prompt`.

- `aspect_ratio`: default `16:9`; one of `1:1`, `16:9`, `9:16`, `4:3`,
  `3:4`, `3:2`, `2:3`, `custom`.
- `width`, `height`: custom ratio only; `256..1440`, multiples of 16.
- `prompt_upsampling`: default `false`.
- `seed`: optional integer.
- `disable_safety_checker`: default `false`.
- `lora_weights`: optional model weights reference.
- `lora_scale`: default `0.5`, range `-1..3`.
- `hf_api_token`: upstream secret; do not pass it from this public skill.

## `ergouzi/e-image-edit`

Required by schema: `prompt`. For an actual edit, also provide `images`.

- `images`: image URI array; put the primary edit target first.
- `turbo`: default `true`.
- `replicate_weights`: default `default`; supported values are `default`,
  `multiple_angles`, `relight`, `light_restoration`, `white_to_scene`, `fusion`,
  `add_characters`, `next_scene`, `style_consistency`, `subject_consistency`,
  `scene_consistency`, `to_anime`, `to_3dchibi`, `to_caricature`, `photous`,
  `extract_texture`, `apply_texture`, `upscale`, `anything_to_real`, and
  `white_film_to_rendering`.
- `aspect_ratio`: default `match_input_image`.
- `seed`: optional integer.
- `disable_safety_checker`: default `false`.
- `no_op`: internal health-check field; do not use for normal tasks.

## `ergouzi/e-image-ideogram`

Required: `prompt`.

- `thinking`: `very low`, `low`, `medium`, or `high`; default `high`.
- `prompt_upsampling`: default `true`.
- `aspect_ratio`: default `1:1`; supports `custom`.
- `image_size`: `1K` or `2K`; default `1K`.
- `width`, `height`: custom dimensions, default `1024`, maximum `2560`.
- `seed`: optional integer.
- `output_format`: `png`, `jpg`, or `webp`; default `jpg`.
- `output_quality`: `0..100`; default `80`.

## `ergouzi/e-image-try-on`

Required: `person_image` and `garment_images`.

- `person_image`: image URI.
- `garment_images`: image URI array; up to 6 recommended, 11 supported.
- `reference_pose`: optional experimental pose image URI.
- `prompt`: optional experimental garment-selection instruction.
- `turbo`: default `false`; avoid it with more than 4 garments.
- `seed`: optional integer.
- `preserve_input_size`: default `true`.
- `output_format`: `webp`, `jpg`, or `png`; default `jpg`.
- `output_quality`: default `95`.
- `no_op`: internal health-check field; do not use for normal tasks.

## `ergouzi/e-image-upscale`

Required: `image`.

- `image`: image URI.
- `upscale_mode`: `target` or `factor`; default `target`.
- `target`: target megapixels in `1..128`; default `4`.
- `factor`: width/height multiplier in `1..8`; default `2`; output is capped at
  128 megapixels.
- `enhance_details`: default `false`.
- `enhance_realism`: default `false`.
- `output_format`: `webp`, `jpg`, or `png`.
- `output_quality`: `0..100`; default `80`.
- `disable_safety_checker`: default `false`.
- `no_op`: internal health-check field; do not use for normal tasks.
