import sys
from pdf2docx import Converter

def main():
    if len(sys.argv) != 3:
        print("Usage: convert_pdf.py <input.pdf> <output.docx>", file=sys.stderr)
        sys.exit(1)

    input_path, output_path = sys.argv[1], sys.argv[2]

    cv = Converter(input_path)
    cv.convert(output_path)
    cv.close()

if __name__ == "__main__":
    main()