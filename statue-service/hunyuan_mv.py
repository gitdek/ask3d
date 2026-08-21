"""EXPERIMENTAL multiview conditioning overlay for the MLX Hunyuan3D port.

Two modes, chosen by `add_view_embed`:

* add_view_embed=True mirrors the torch DinoImageEncoderMV semantics exactly
  (verified against hy3dshape/models/conditioner.py): per-view sincos
  embedding of the view INDEX added to every token (CLS included), views
  sorted by index and concatenated along the token axis, zeros uncond of the
  concatenated length. Smoke-tested 2026-08-21 on the single-view 2.1
  checkpoint: denoises to an EMPTY SDF — no MV weights exist for 2.1 (only
  tencent/Hunyuan3D-2mv, a different 2.0-era architecture), and a DiT never
  trained with view-perturbed tokens treats them as corruption. Kept for a
  future MV-trained checkpoint.

* add_view_embed=False (the working mode): plain token concat. Every token
  stays in-distribution; the DiT pools evidence from all views via
  cross-attention. No view identity, so the canonical yaw of the output is
  arbitrary — harmless for printing (repair only fixes upright).

View index mapping (hy3dshape/preprocessors.py MVImageProcessorV2):
  front=0, left=1, back=2, right=3.
"""

import mlx.core as mx
import numpy as np

VIEW2IDX = {"front": 0, "left": 1, "back": 2, "right": 3}
VIEW_NUM = 4


def sincos_1d(embed_dim: int, positions: np.ndarray) -> np.ndarray:
    """Identical math to hy3dshape's get_1d_sincos_pos_embed_from_grid."""
    assert embed_dim % 2 == 0
    omega = np.arange(embed_dim // 2, dtype=np.float64)
    omega /= embed_dim / 2.0
    omega = 1.0 / 10000**omega
    out = np.einsum("m,d->md", positions.reshape(-1), omega)
    return np.concatenate([np.sin(out), np.cos(out)], axis=1)


class MultiViewEncoderProxy:
    """Wraps the port's single-view ImageEncoder for multiview conditioning.

    Call with a stacked (n_views, H, W, 3) tensor whose views are sorted by
    VIEW2IDX; returns (1, n_views * num_patches, hidden) conditioning.
    """

    def __init__(self, encoder, view_idxs: list, add_view_embed: bool = True) -> None:
        self._encoder = encoder
        self.view_idxs = list(view_idxs)
        # The torch MV recipe adds sincos view embeddings, but only an
        # MV-trained DiT has seen tokens perturbed that way — on the
        # single-view 2.1 checkpoint they denoise to an empty SDF. Plain
        # token concat keeps each token in-distribution.
        self.add_view_embed = add_view_embed
        table = sincos_1d(encoder.hidden_size, np.arange(VIEW_NUM, dtype=np.float32))
        self._view_embed = mx.array(table.astype(np.float32))

    def __call__(self, image: mx.array, value_range=(-1, 1)) -> mx.array:
        tokens = self._encoder(image, value_range=value_range)  # (n, P, D)
        if self.add_view_embed:
            embed = self._view_embed[mx.array(self.view_idxs)].astype(tokens.dtype)  # (n, D)
            tokens = tokens + embed[:, None, :]
        return tokens.reshape(1, -1, tokens.shape[-1])  # (1, n*P, D)

    def unconditional_embedding(self, batch_size: int) -> mx.array:
        zero = self._encoder.unconditional_embedding(batch_size)  # (bs, P, D)
        return mx.concatenate([zero] * len(self.view_idxs), axis=1)  # (bs, n*P, D)

    def __getattr__(self, name):
        return getattr(self._encoder, name)


def sort_views(view_to_image: dict) -> tuple:
    """({'front': img, ...}) -> (sorted image list, sorted view idx list)."""
    unknown = set(view_to_image) - set(VIEW2IDX)
    if unknown:
        raise ValueError(f"unknown view tags {unknown}; valid: {sorted(VIEW2IDX)}")
    pairs = sorted((VIEW2IDX[tag], img) for tag, img in view_to_image.items())
    return [img for _, img in pairs], [idx for idx, _ in pairs]
