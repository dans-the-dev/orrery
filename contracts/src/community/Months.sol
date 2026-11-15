// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice UTC calendar months as an index `year * 12 + month - 1` (January 1970 = 23640), for timestamps from 1970 on.
/// Day arithmetic after Howard Hinnant's `days_from_civil` and `civil_from_days` (proleptic Gregorian calendar).
library Months {
    function monthOf(uint256 timestamp) internal pure returns (uint256) {
        (uint256 y, uint256 m) = _yearMonth(timestamp / 1 days);
        return y * 12 + m - 1;
    }

    /// @notice First second (UTC) of month `index`.
    function startOf(uint256 index) internal pure returns (uint256) {
        return _daysFromCivil(index / 12, index % 12 + 1) * 1 days;
    }

    function _daysFromCivil(uint256 y, uint256 m) private pure returns (uint256) {
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 doy = (153 * (m > 2 ? m - 3 : m + 9) + 2) / 5; // day 1 of the month
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        return era * 146_097 + doe - 719_468;
    }

    function _yearMonth(uint256 z) private pure returns (uint256 y, uint256 m) {
        z += 719_468;
        uint256 era = z / 146_097;
        uint256 doe = z - era * 146_097;
        uint256 yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        y = yoe + era * 400;
        uint256 doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        uint256 mp = (5 * doy + 2) / 153;
        m = mp < 10 ? mp + 3 : mp - 9;
        if (m <= 2) y += 1;
    }
}
