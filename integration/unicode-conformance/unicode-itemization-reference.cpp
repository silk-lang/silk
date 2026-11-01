// Baseline-only adapter for the SHA256-pinned ICU release-78.1 ScriptRun sample.
// The sample algorithm is compiled unchanged. Only UTF-16 -> UTF-8 positions
// and UScriptCode -> ISO 15924 output conversion happen here.
#include "scrptrun.h"
#include <unicode/uchar.h>
#include <unicode/unistr.h>
#include <unicode/utf8.h>
#include <unicode/utf16.h>
#include <unicode/uversion.h>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <limits>
#include <vector>

int main(int argc, char **argv) {
    if (argc != 2) {
        std::cerr << "usage: unicode-itemization-reference TEXT|--version\n";
        return 2;
    }
    if (std::strcmp(argv[1], "--version") == 0) {
        UVersionInfo version;
        char formatted[U_MAX_VERSION_STRING_LENGTH];
        u_getVersion(version);
        u_versionToString(version, formatted);
        std::cout << "ICU " << formatted;
        u_getUnicodeVersion(version);
        u_versionToString(version, formatted);
        std::cout << "; Unicode " << formatted << '\n';
        return 0;
    }
    const size_t size = std::strlen(argv[1]);
    if (size > static_cast<size_t>(std::numeric_limits<int32_t>::max())) {
        std::cerr << "input exceeds ICU int32 length\n";
        return 2;
    }
    const int32_t length = static_cast<int32_t>(size);
    const auto text = icu::UnicodeString::fromUTF8(icu::StringPiece(argv[1], length));
    std::vector<int32_t> bytes(static_cast<size_t>(text.length()) + 1, -1);
    int32_t byte = 0;
    int32_t unit = 0;
    bytes[0] = 0;
    while (byte < length) {
        UChar32 cp;
        U8_NEXT(argv[1], byte, length, cp);
        if (cp < 0) {
            std::cerr << "reference accepts only valid UTF-8\n";
            return 2;
        }
        unit += U16_LENGTH(cp);
        bytes[unit] = byte;
    }
    icu::ScriptRun runs(text.getBuffer(), text.length());
    while (runs.next()) {
        const auto start = bytes.at(runs.getScriptStart());
        const auto end = bytes.at(runs.getScriptEnd());
        const char *name = uscript_getShortName(runs.getScriptCode());
        if (start < 0 || end < 0 || name == nullptr || std::strlen(name) != 4) {
            std::cerr << "invalid ICU script run\n";
            return 2;
        }
        uint32_t tag = 0;
        for (int i = 0; i != 4; ++i) {
            tag = (tag << 8) | static_cast<unsigned char>(name[i]);
        }
        std::cout << start << ' ' << end << ' ' << tag << '\n';
    }
    return 0;
}
