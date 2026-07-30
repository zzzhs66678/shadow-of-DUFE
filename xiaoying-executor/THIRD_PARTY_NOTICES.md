# Third-party notices

## IGoLibrary

The TraceInt library-domain adapter in this directory was designed after studying:

- Project: [EJianZQ/IGoLibrary](https://github.com/EJianZQ/IGoLibrary)
- License declared by the upstream repository: MIT
- Upstream version studied: commit `16b5089e`

The original application is written in .NET/Avalonia. East Finance Shadow uses a separate JavaScript data contract,
storage layer, safety confirmation flow and user interface. Protocol shapes and normal reservation behavior were
adapted from the upstream `ITraceIntApiClient`, transport, response mapper and domain models.

The upstream MIT text is preserved in `IGOLIBRARY_LICENSE.txt`. Its copyright fields currently remain the upstream
placeholders (`[year] [fullname]`). Before any commercial public release, preserve both files and contact the upstream
author to clarify attribution details.

This project intentionally does not migrate high-frequency seat grabbing, global leak scanning, seat occupying,
remote check-in, or location simulation.
