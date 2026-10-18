package auth

import (
	"fmt"
	"strings"

	"rsc.io/qr"
)

// RenderQRSVG encodes text as a QR code and returns a self-contained SVG image.
func RenderQRSVG(text string) (string, error) {
	code, err := qr.Encode(text, qr.M)
	if err != nil {
		return "", err
	}
	const margin = 2
	size := code.Size + 2*margin
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" shape-rendering="crispEdges" role="img" aria-label="Pairing QR code">`, size, size)
	fmt.Fprintf(&b, `<rect width="%d" height="%d" fill="#ffffff"/>`, size, size)
	b.WriteString(`<path fill="#000000" d="`)
	for y := 0; y < code.Size; y++ {
		for x := 0; x < code.Size; x++ {
			if code.Black(x, y) {
				fmt.Fprintf(&b, "M%d,%dh1v1h-1z", x+margin, y+margin)
			}
		}
	}
	b.WriteString(`"/></svg>`)
	return b.String(), nil
}
