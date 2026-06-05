import sys
import os
import time

from rembg import remove, new_session

# Session created once at module level — avoids re-loading ONNX weights on every call
_session = new_session('u2net')

def remove_background(input_path: str, output_path: str) -> bool:
    try:
        from PIL import Image
        import io

        with open(input_path, 'rb') as f:
            input_data = f.read()

        start = time.time()
        output_data = remove(input_data, session=_session)
        print(f'[rembg] Model inference: {round(time.time() - start, 1)}s')

        img = Image.open(io.BytesIO(output_data))
        img.save(output_path, 'PNG')

        print(f'[rembg] Success: {output_path}')
        print(f'[rembg] Size: {os.path.getsize(output_path)} bytes')
        return True

    except Exception as e:
        print(f'[rembg] Error: {e}', file=sys.stderr)
        return False

if __name__ == '__main__':
    if len(sys.argv) != 3:
        print('Usage: python rembg_worker.py <input_path> <output_path>', file=sys.stderr)
        sys.exit(1)

    success = remove_background(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
