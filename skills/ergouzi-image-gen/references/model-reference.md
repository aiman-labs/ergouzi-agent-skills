# Image Model Reference

This is the objective request contract verified from the live model schema in
the local New API database on 2026-08-10. The server remains the source of truth
and returns validation errors for unsupported fields.

Most models use:

```text
POST /customer/v1/models/{owner}/{model}/predictions
Authorization: Bearer <Ergouzi API key>
Content-Type: application/json

{"input": { ...model fields... }}
```

`ergouzi/e-rmbg` is a version-pinned community deployment and instead uses:

```text
POST /customer/v1/predictions
Authorization: Bearer <Ergouzi API key>
Content-Type: application/json

{"version":"a029dff38972b5fda4ec5d75d7d1cd25aeff621d2cf4946a41055d7db66b80bc","input":{...model fields...}}
```

The runner injects this immutable deployment version. Callers continue to use
the public `ergouzi/e-rmbg` model name and provide only the model input.

The Skill accepts documented media fields as HTTPS URLs, supported base64 data
URIs, or local `$local_file` objects. It validates local file signatures before
converting them to data URIs. The final JSON request must remain within 4 MiB;
use HTTPS URLs for larger media. All six models return one image output URI;
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

## `ergouzi/e-rmbg`

Required: `image`. This model does not use a prompt. The following is the
working example shown by the API documentation:

```json
{
  "background_type": "rgba",
  "format": "png",
  "image": "https://example.com/input",
  "reverse": false,
  "threshold": 0
}
```

- `image`: JPEG, PNG, or WebP URI. Use `--image` for a local path or HTTPS URL.
- `background_type`: default `rgba`; the live description lists `rgba`, `map`,
  `green`, `white`, an `[R,G,B]` color array, `blur`, `overlay`, or a path to
  an image. The schema declares this field as a string, so pass the exact form
  accepted by the server for non-`rgba` values.
- `format`: default `png`; the live description gives `png` and `jpg` as
  examples rather than a closed enum.
- `reverse`: default `false`; when `true`, remove the foreground instead of
  the background.
- `threshold`: default `0`, a number in `0.0..1.0`; `0.0` uses soft alpha,
  while a positive value enables hard segmentation.

The required `image` plus the example defaults are sufficient for a basic
background-removal request. The API remains the source of truth if the model
deployment adds or changes accepted values.

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
